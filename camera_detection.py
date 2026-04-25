import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.request

import cv2

try:
	import mediapipe as mp  # type: ignore

	_HAS_MEDIAPIPE = True
except ImportError:
	mp = None  # type: ignore
	_HAS_MEDIAPIPE = False


def angle_from_vertical(dx: float, dy: float) -> float:
	"""Returns absolute angle (degrees) between vector and vertical axis."""
	return abs(math.degrees(math.atan2(dx, -dy)))


def get_landmark_xy(landmark, width: int, height: int):
	return int(landmark.x * width), int(landmark.y * height)


def posture_state_from_pose(
	result,
	mp_pose,
	slouch_threshold_deg: float,
	close_to_monitor_threshold: float,
):
	"""MediaPipe pose: same logic as before (torso tilt + depth lean)."""
	status_text = "NO PERSON"
	tilt_deg = 0.0
	forward_lean = 0.0
	slouching = False
	close_to_monitor = False

	if result.pose_landmarks:
		landmarks = result.pose_landmarks.landmark

		nose = landmarks[mp_pose.PoseLandmark.NOSE]
		left_shoulder = landmarks[mp_pose.PoseLandmark.LEFT_SHOULDER]
		right_shoulder = landmarks[mp_pose.PoseLandmark.RIGHT_SHOULDER]
		left_hip = landmarks[mp_pose.PoseLandmark.LEFT_HIP]
		right_hip = landmarks[mp_pose.PoseLandmark.RIGHT_HIP]

		shoulder_mid_x = (left_shoulder.x + right_shoulder.x) / 2.0
		shoulder_mid_y = (left_shoulder.y + right_shoulder.y) / 2.0
		shoulder_mid_z = (left_shoulder.z + right_shoulder.z) / 2.0
		hip_mid_x = (left_hip.x + right_hip.x) / 2.0
		hip_mid_y = (left_hip.y + right_hip.y) / 2.0

		dx = shoulder_mid_x - hip_mid_x
		dy = shoulder_mid_y - hip_mid_y

		tilt_deg = angle_from_vertical(dx, dy)
		slouching = tilt_deg > slouch_threshold_deg

		forward_lean = shoulder_mid_z - nose.z
		close_to_monitor = forward_lean > close_to_monitor_threshold

		if slouching and close_to_monitor:
			status_text = "YOU ARE TOO SLOUCHED"
		elif slouching:
			status_text = "YOU ARE TOO SLOUCHED"
		elif close_to_monitor:
			status_text = "YOU ARE TOO SLOUCHED"
		else:
			status_text = "GOOD POSTURE"

	return {
		"status": status_text,
		"tilt_deg": float(tilt_deg),
		"forward_lean": float(forward_lean),
		"slouching": bool(slouching),
		"close_to_monitor": bool(close_to_monitor),
		"slouch_threshold_deg": float(slouch_threshold_deg),
		"close_to_monitor_threshold": float(close_to_monitor_threshold),
	}


def posture_state_from_opencv(
	frame_bgr,
	face_cascade: cv2.CascadeClassifier,
	eye_cascade: cv2.CascadeClassifier,
	slouch_threshold_deg: float,
	close_area_threshold: float,
	cv_state: dict,
	*,
	y_anchor: float,
	vertical_gain: float,
	smooth_alpha: float,
):
	"""
	OpenCV-only (Haar): no MediaPipe, works on Python 3.13.

	- tilt_deg: max(head roll from eye line, vertical drop of face in frame).
	- forward_lean: face bounding-box area as fraction of frame (larger = closer / leaning in).
	- close_to_monitor_threshold: use --opencv-close-area (default ~0.12), not the MediaPipe z scale.
	"""
	h, w = frame_bgr.shape[:2]
	if w < 32 or h < 32:
		return {
			"status": "NO PERSON",
			"tilt_deg": 0.0,
			"forward_lean": 0.0,
			"slouching": False,
			"close_to_monitor": False,
			"slouch_threshold_deg": float(slouch_threshold_deg),
			"close_to_monitor_threshold": float(close_area_threshold),
			"_viz": None,
		}

	gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
	gray = cv2.equalizeHist(gray)
	min_face = max(40, int(min(w, h) * 0.08))
	faces = face_cascade.detectMultiScale(
		gray,
		scaleFactor=1.12,
		minNeighbors=5,
		minSize=(min_face, min_face),
	)

	if faces is None or len(faces) == 0:
		cv_state.pop("tilt_ema", None)
		cv_state.pop("lean_ema", None)
		return {
			"status": "NO PERSON",
			"tilt_deg": 0.0,
			"forward_lean": 0.0,
			"slouching": False,
			"close_to_monitor": False,
			"slouch_threshold_deg": float(slouch_threshold_deg),
			"close_to_monitor_threshold": float(close_area_threshold),
			"_viz": None,
		}

	x, y, fw, fh = max(faces, key=lambda r: r[2] * r[3])
	roi_gray = gray[y : y + fh, x : x + fw]
	roll_deg = 0.0
	eyes = ()
	if roi_gray.size > 0:
		eyes = eye_cascade.detectMultiScale(roi_gray, scaleFactor=1.1, minNeighbors=3, minSize=(8, 8))
		if eyes is not None and len(eyes) >= 2:
			centers = []
			for (ex, ey, ew, eh) in eyes[:6]:
				cx = x + ex + ew * 0.5
				cy = y + ey + eh * 0.5
				centers.append((cx, cy))
			centers.sort(key=lambda p: p[0])
			best_roll = 0.0
			for i in range(len(centers)):
				for j in range(i + 1, len(centers)):
					dx = centers[j][0] - centers[i][0]
					dy = centers[j][1] - centers[i][1]
					if abs(dx) < 1e-3:
						continue
					ang = abs(math.degrees(math.atan2(dy, dx)))
					best_roll = max(best_roll, min(ang, 90.0 - ang))
			roll_deg = best_roll

	face_cy = y + fh * 0.5
	norm_y = face_cy / float(h)
	vertical_deg = max(0.0, (norm_y - y_anchor) * vertical_gain)
	tilt_raw = max(roll_deg, vertical_deg)
	prev_t = float(cv_state.get("tilt_ema", tilt_raw))
	tilt_deg = smooth_alpha * tilt_raw + (1.0 - smooth_alpha) * prev_t
	cv_state["tilt_ema"] = tilt_deg

	area_frac = (fw * fh) / float(w * h)
	prev_l = float(cv_state.get("lean_ema", area_frac))
	forward_lean = smooth_alpha * area_frac + (1.0 - smooth_alpha) * prev_l
	cv_state["lean_ema"] = forward_lean

	slouching = tilt_deg > slouch_threshold_deg
	close_to_monitor = forward_lean > close_area_threshold

	if slouching and close_to_monitor:
		status_text = "YOU ARE TOO SLOUCHED"
	elif slouching:
		status_text = "YOU ARE TOO SLOUCHED"
	elif close_to_monitor:
		status_text = "YOU ARE TOO SLOUCHED"
	else:
		status_text = "GOOD POSTURE"

	viz = {"face_rect": (int(x), int(y), int(fw), int(fh)), "eye_centers": []}
	if eyes is not None and len(eyes) > 0:
		for (ex, ey, ew, eh) in eyes[:6]:
			viz["eye_centers"].append((int(x + ex + ew * 0.5), int(y + ey + eh * 0.5)))

	return {
		"status": status_text,
		"tilt_deg": float(tilt_deg),
		"forward_lean": float(forward_lean),
		"slouching": bool(slouching),
		"close_to_monitor": bool(close_to_monitor),
		"slouch_threshold_deg": float(slouch_threshold_deg),
		"close_to_monitor_threshold": float(close_area_threshold),
		"_viz": viz,
	}


def push_posture_to_backend(base_url: str, payload: dict) -> bool:
	"""POST one snapshot to Node (backend.js POST /api/posture/latest) for the React panel."""
	url = base_url.rstrip("/") + "/api/posture/latest"
	body = json.dumps(payload).encode("utf-8")
	req = urllib.request.Request(
		url,
		data=body,
		headers={"Content-Type": "application/json"},
		method="POST",
	)
	try:
		with urllib.request.urlopen(req, timeout=8) as resp:
			if resp.status != 200:
				print(f"Backend posture push: HTTP {resp.status}", file=sys.stderr)
				return False
			return True
	except urllib.error.HTTPError as exc:
		err_body = exc.read().decode("utf-8", errors="replace")[:500]
		print(f"Backend posture push HTTP {exc.code}: {err_body}", file=sys.stderr)
	except urllib.error.URLError as exc:
		print(f"Backend posture push failed: {exc}", file=sys.stderr)
	return False


def main():
	parser = argparse.ArgumentParser(description="Posture detection from webcam or HTTP GET stream")
	parser.add_argument(
		"--stream-url",
		default="0",
		help="Video source: camera index (0, 1, ...) or HTTP URL (example: http://localhost:8080/video)",
	)
	parser.add_argument(
		"--mode",
		choices=["headless", "normal"],
		default="normal",
		help="Run mode: headless logs only, normal also displays OpenCV window",
	)
	parser.add_argument(
		"--engine",
		choices=["auto", "mediapipe", "opencv"],
		default="auto",
		help="auto: mediapipe if installed, else OpenCV Haar (Python 3.13 friendly).",
	)
	parser.add_argument(
		"--backend-url",
		default=None,
		help="If set, POST posture JSON to <url>/api/posture/latest on each log interval (see --push-interval).",
	)
	parser.add_argument(
		"--push-interval",
		type=float,
		default=1.0,
		help="Seconds between backend POSTs when --backend-url is set.",
	)
	parser.add_argument(
		"--opencv-close-area",
		type=float,
		default=0.12,
		help="OpenCV engine: face box area / frame area above this => too close (leaning in).",
	)
	parser.add_argument(
		"--opencv-y-anchor",
		type=float,
		default=0.34,
		help="OpenCV engine: normalized face center Y above this adds vertical tilt (slouch proxy).",
	)
	parser.add_argument(
		"--opencv-vertical-gain",
		type=float,
		default=48.0,
		help="OpenCV engine: multiply (norm_y - anchor) for vertical tilt degrees.",
	)
	parser.add_argument(
		"--opencv-smooth",
		type=float,
		default=0.35,
		help="OpenCV engine: EMA alpha for tilt/lean smoothing (0..1).",
	)
	args = parser.parse_args()

	engine = args.engine
	if engine == "auto":
		engine = "mediapipe" if _HAS_MEDIAPIPE else "opencv"
	elif engine == "mediapipe" and not _HAS_MEDIAPIPE:
		print("mediapipe not installed; using opencv engine.", file=sys.stderr)
		engine = "opencv"

	stream_source = int(args.stream_url) if str(args.stream_url).isdigit() else args.stream_url
	cap = cv2.VideoCapture(stream_source)
	if not cap.isOpened():
		print(f"Could not open stream source: {args.stream_url}")
		return

	slouch_threshold_deg = 18.0
	close_to_monitor_threshold_mp = 0.96
	close_area_threshold = float(args.opencv_close_area)
	y_anchor = float(args.opencv_y_anchor)
	vertical_gain = float(args.opencv_vertical_gain)
	smooth_alpha = min(1.0, max(0.05, float(args.opencv_smooth)))

	last_status = ""
	last_log_time = 0.0
	log_interval_seconds = max(0.25, float(args.push_interval))
	cv_state: dict = {}

	face_cascade = None
	eye_cascade = None
	if engine == "opencv":
		face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
		eye_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye.xml")
		if face_cascade.empty() or eye_cascade.empty():
			print("Failed to load Haar cascades from OpenCV data.", file=sys.stderr)
			return

	print(
		f"Posture detection ({engine}) started. "
		+ ("Press Q in the OpenCV window to stop." if args.mode == "normal" else "Press Ctrl+C to stop.")
	)
	print(f"Stream source: {args.stream_url}")
	if args.backend_url:
		print(f"Backend push: {args.backend_url.rstrip('/')}/api/posture/latest every {log_interval_seconds:.2f}s")
	elif args.mode == "headless":
		print(
			"Tip: add --backend-url http://127.0.0.1:3000 (or Pi LAN IP) so the dashboard receives posture.",
			file=sys.stderr,
		)

	def process_frame_mp(frame, pose):
		rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
		result = pose.process(rgb)
		return posture_state_from_pose(
			result, mp.solutions.pose, slouch_threshold_deg, close_to_monitor_threshold_mp
		), result

	def process_frame_cv(frame):
		assert face_cascade is not None and eye_cascade is not None
		metrics = posture_state_from_opencv(
			frame,
			face_cascade,
			eye_cascade,
			slouch_threshold_deg,
			close_area_threshold,
			cv_state,
			y_anchor=y_anchor,
			vertical_gain=vertical_gain,
			smooth_alpha=smooth_alpha,
		)
		return metrics, None

	first_posture_push_ok = False

	def emit_log_and_push(metrics: dict) -> None:
		nonlocal last_status, last_log_time, first_posture_push_ok
		status_text = metrics["status"]
		tilt_deg = metrics["tilt_deg"]
		forward_lean = metrics["forward_lean"]
		th = metrics["close_to_monitor_threshold"]

		now = time.time()
		if status_text != last_status or (now - last_log_time) >= log_interval_seconds:
			print(
				f"status={status_text} | tilt={tilt_deg:.1f} deg | lean={forward_lean:.3f} | "
				f"slouch_threshold={slouch_threshold_deg:.2f} | close_threshold={th:.4f}"
			)
			last_status = status_text
			last_log_time = now

			if args.backend_url:
				push_payload = {
					"status": metrics["status"],
					"tilt_deg": metrics["tilt_deg"],
					"forward_lean": metrics["forward_lean"],
					"slouching": metrics["slouching"],
					"close_to_monitor": metrics["close_to_monitor"],
					"slouch_threshold_deg": metrics["slouch_threshold_deg"],
					"close_to_monitor_threshold": metrics["close_to_monitor_threshold"],
					"source": "mediapipe" if engine == "mediapipe" else "opencv_face",
				}
				if push_posture_to_backend(args.backend_url, push_payload) and not first_posture_push_ok:
					first_posture_push_ok = True
					print("First POST to /api/posture/latest succeeded (check dashboard + Node log).")

	def draw_mediapipe_overlay(display_frame, frame_w, frame_h, mp_pose_cls, result) -> None:
		if not result or not result.pose_landmarks:
			return
		landmarks = result.pose_landmarks.landmark
		nose = landmarks[mp_pose_cls.PoseLandmark.NOSE]
		left_shoulder = landmarks[mp_pose_cls.PoseLandmark.LEFT_SHOULDER]
		right_shoulder = landmarks[mp_pose_cls.PoseLandmark.RIGHT_SHOULDER]
		left_hip = landmarks[mp_pose_cls.PoseLandmark.LEFT_HIP]
		right_hip = landmarks[mp_pose_cls.PoseLandmark.RIGHT_HIP]
		nose_xy = get_landmark_xy(nose, frame_w, frame_h)
		shoulder_mid_xy = (
			int(((left_shoulder.x + right_shoulder.x) / 2.0) * frame_w),
			int(((left_shoulder.y + right_shoulder.y) / 2.0) * frame_h),
		)
		hip_mid_xy = (
			int(((left_hip.x + right_hip.x) / 2.0) * frame_w),
			int(((left_hip.y + right_hip.y) / 2.0) * frame_h),
		)
		cv2.circle(display_frame, nose_xy, 5, (255, 255, 255), -1)
		cv2.circle(display_frame, shoulder_mid_xy, 6, (0, 255, 255), -1)
		cv2.circle(display_frame, hip_mid_xy, 6, (255, 255, 0), -1)
		cv2.line(display_frame, hip_mid_xy, shoulder_mid_xy, (0, 255, 255), 2)

	def draw_opencv_overlay(display_frame, metrics: dict) -> None:
		viz = metrics.get("_viz")
		if not viz:
			return
		x0, y0, fw0, fh0 = viz["face_rect"]
		cv2.rectangle(display_frame, (x0, y0), (x0 + fw0, y0 + fh0), (0, 255, 255), 2)
		pts = viz.get("eye_centers") or []
		for (cx, cy) in pts:
			cv2.circle(display_frame, (cx, cy), 4, (255, 255, 0), -1)
		if len(pts) >= 2:
			sorted_pts = sorted(pts, key=lambda p: p[0])
			cv2.line(display_frame, sorted_pts[0], sorted_pts[-1], (0, 255, 0), 1, cv2.LINE_AA)

	def one_iteration(pose_obj) -> bool:
		ok, frame = cap.read()
		if not ok:
			print("Camera frame read failed.")
			return False

		frame = cv2.flip(frame, 1)
		display_frame = frame.copy()
		h, w = frame.shape[:2]

		if engine == "mediapipe":
			metrics, result = process_frame_mp(frame, pose_obj)
		else:
			metrics, result = process_frame_cv(frame)

		emit_log_and_push(metrics)

		if args.mode == "normal":
			status_text = metrics["status"]
			is_bad = status_text == "YOU ARE TOO SLOUCHED"
			color = (0, 0, 255) if is_bad else (0, 200, 0)
			cv2.putText(
				display_frame,
				status_text,
				(20, 35),
				cv2.FONT_HERSHEY_SIMPLEX,
				0.9,
				color,
				2,
				cv2.LINE_AA,
			)
			cv2.putText(
				display_frame,
				f"Tilt: {metrics['tilt_deg']:.1f} deg  Lean: {metrics['forward_lean']:.3f}",
				(20, 70),
				cv2.FONT_HERSHEY_SIMPLEX,
				0.7,
				(255, 255, 255),
				2,
				cv2.LINE_AA,
			)
			cv2.putText(
				display_frame,
				"Press Q to close",
				(20, 110),
				cv2.FONT_HERSHEY_SIMPLEX,
				0.65,
				(255, 255, 255),
				2,
				cv2.LINE_AA,
			)
			if engine == "mediapipe":
				draw_mediapipe_overlay(display_frame, w, h, mp.solutions.pose, result)
			else:
				draw_opencv_overlay(display_frame, metrics)

			cv2.imshow("Posture Detection", display_frame)
			if (cv2.waitKey(1) & 0xFF) == ord("q"):
				return False

		return True

	if engine == "mediapipe":
		mp_pose_cls = mp.solutions.pose
		with mp_pose_cls.Pose(
			static_image_mode=False,
			model_complexity=1,
			smooth_landmarks=True,
			min_detection_confidence=0.5,
			min_tracking_confidence=0.5,
		) as pose:
			while one_iteration(pose):
				pass
	else:
		while one_iteration(None):
			pass

	cap.release()
	if args.mode == "normal":
		cv2.destroyAllWindows()


if __name__ == "__main__":
	main()