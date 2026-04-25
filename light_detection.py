"""AI-based room lighting detection.

This module provides a lightweight ML pipeline to classify room lighting
conditions from an image into: "dark", "dim", "normal", "bright".

Dependencies:
- numpy
- Pillow
- scikit-learn

Install:
	pip install numpy Pillow scikit-learn
	Webcam: pip install opencv-python-headless  # or opencv-python
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Tuple

import joblib
import numpy as np
from PIL import Image
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


LIGHT_LABELS = ("dark", "dim", "normal", "bright")


def push_lighting_ml_to_backend(base_url: str, label: str, confidence: float, brightness_score: float) -> None:
	"""POST one prediction to Node backend (backend.js POST /api/lighting/ml)."""
	url = base_url.rstrip("/") + "/api/lighting/ml"
	payload = json.dumps(
		{
			"label": label,
			"confidence": float(confidence),
			"brightness_score": float(brightness_score),
		}
	).encode("utf-8")
	req = urllib.request.Request(
		url,
		data=payload,
		headers={"Content-Type": "application/json"},
		method="POST",
	)
	try:
		with urllib.request.urlopen(req, timeout=8) as resp:
			if resp.status != 200:
				print(f"Backend ML push: HTTP {resp.status}", file=sys.stderr)
	except urllib.error.HTTPError as exc:
		body = exc.read().decode("utf-8", errors="replace")[:500]
		print(f"Backend ML push HTTP {exc.code}: {body}", file=sys.stderr)
	except urllib.error.URLError as exc:
		print(f"Backend ML push failed: {exc}", file=sys.stderr)


@dataclass
class LightingPrediction:
	label: str
	confidence: float
	brightness_score: float


class LightDetectionModel:
	"""Simple AI model that classifies lighting conditions from images."""

	def __init__(self) -> None:
		self.pipeline: Pipeline = Pipeline(
			steps=[
				("scaler", StandardScaler()),
				(
					"clf",
					LogisticRegression(
						max_iter=1500,
						class_weight="balanced",
					),
				),
			]
		)
		self.is_trained: bool = False

	def train_builtin_pretrained(self, seed: int = 42) -> None:
		"""Train an internal model on synthetic lighting data.

		This gives an immediate out-of-the-box classifier so callers can run
		predictions without creating and storing a separate model file.
		"""
		rng = np.random.default_rng(seed)
		x, y = self._build_synthetic_dataset(rng=rng, samples_per_class=500)
		self.pipeline.fit(x, y)
		self.is_trained = True

	@staticmethod
	def _build_synthetic_dataset(
		rng: np.random.Generator, samples_per_class: int
	) -> Tuple[np.ndarray, np.ndarray]:
		"""Create synthetic feature vectors shaped like extract_features output."""
		classes = {
			"dark": (0.08, 0.20),
			"dim": (0.20, 0.42),
			"normal": (0.42, 0.68),
			"bright": (0.68, 0.95),
		}

		x_rows: List[np.ndarray] = []
		y_rows: List[str] = []

		for label, (low, high) in classes.items():
			for _ in range(samples_per_class):
				mean_gray = float(rng.uniform(low, high))
				std_gray = float(rng.uniform(0.04, 0.20))
				p10 = float(np.clip(mean_gray - rng.uniform(0.06, 0.20), 0.0, 1.0))
				p50 = mean_gray
				p90 = float(np.clip(mean_gray + rng.uniform(0.06, 0.20), 0.0, 1.0))
				mean_value = float(np.clip(mean_gray + rng.uniform(0.01, 0.12), 0.0, 1.0))
				dark_ratio = float(np.clip(1.0 - (mean_gray * rng.uniform(1.1, 1.8)), 0.0, 1.0))
				bright_ratio = float(np.clip((mean_gray - 0.45) * rng.uniform(1.4, 2.4), 0.0, 1.0))

				r_shift = rng.normal(0.0, 0.03)
				g_shift = rng.normal(0.0, 0.03)
				b_shift = rng.normal(0.0, 0.03)
				mean_r = float(np.clip(mean_gray + r_shift, 0.0, 1.0))
				mean_g = float(np.clip(mean_gray + g_shift, 0.0, 1.0))
				mean_b = float(np.clip(mean_gray + b_shift, 0.0, 1.0))

				std_r = float(np.clip(std_gray + rng.normal(0.0, 0.02), 0.0, 1.0))
				std_g = float(np.clip(std_gray + rng.normal(0.0, 0.02), 0.0, 1.0))
				std_b = float(np.clip(std_gray + rng.normal(0.0, 0.02), 0.0, 1.0))

				hist = np.zeros(8, dtype=np.float32)
				bin_idx = min(7, max(0, int(mean_gray * 8)))
				hist[bin_idx] = 1.0
				hist += rng.uniform(0.0, 0.08, size=8)
				hist = hist / np.sum(hist)

				features = np.array(
					[
						mean_gray,
						std_gray,
						p10,
						p50,
						p90,
						mean_value,
						dark_ratio,
						bright_ratio,
						mean_r,
						mean_g,
						mean_b,
						std_r,
						std_g,
						std_b,
						*hist.tolist(),
					],
					dtype=np.float32,
				)
				x_rows.append(features)
				y_rows.append(label)

		return np.vstack(x_rows), np.array(y_rows)

	@staticmethod
	def _load_image_rgb(image_path: str | Path, target_size: Tuple[int, int] = (224, 224)) -> np.ndarray:
		image = Image.open(image_path).convert("RGB").resize(target_size)
		return np.asarray(image, dtype=np.float32) / 255.0

	@staticmethod
	def extract_features(rgb_image: np.ndarray) -> np.ndarray:
		"""Extract brightness/color features for model input."""
		gray = 0.299 * rgb_image[:, :, 0] + 0.587 * rgb_image[:, :, 1] + 0.114 * rgb_image[:, :, 2]

		# Value channel approximation (max RGB) helps capture perceived light level.
		value = np.max(rgb_image, axis=2)

		mean_gray = float(np.mean(gray))
		std_gray = float(np.std(gray))
		p10 = float(np.percentile(gray, 10))
		p50 = float(np.percentile(gray, 50))
		p90 = float(np.percentile(gray, 90))

		mean_value = float(np.mean(value))
		dark_ratio = float(np.mean(gray < 0.2))
		bright_ratio = float(np.mean(gray > 0.8))

		channel_means = np.mean(rgb_image, axis=(0, 1))
		channel_stds = np.std(rgb_image, axis=(0, 1))

		hist, _ = np.histogram(gray, bins=8, range=(0.0, 1.0), density=True)

		features = np.array(
			[
				mean_gray,
				std_gray,
				p10,
				p50,
				p90,
				mean_value,
				dark_ratio,
				bright_ratio,
				float(channel_means[0]),
				float(channel_means[1]),
				float(channel_means[2]),
				float(channel_stds[0]),
				float(channel_stds[1]),
				float(channel_stds[2]),
				*hist.tolist(),
			],
			dtype=np.float32,
		)
		return features

	def build_training_matrix(
		self, samples: Iterable[Tuple[str | Path, str]]
	) -> Tuple[np.ndarray, np.ndarray]:
		"""Create feature matrix and label vector from image paths and labels."""
		x_rows: List[np.ndarray] = []
		y_rows: List[str] = []

		for image_path, label in samples:
			if label not in LIGHT_LABELS:
				raise ValueError(
					f"Invalid label '{label}'. Expected one of: {', '.join(LIGHT_LABELS)}"
				)
			rgb = self._load_image_rgb(image_path)
			x_rows.append(self.extract_features(rgb))
			y_rows.append(label)

		if not x_rows:
			raise ValueError("No training samples provided.")

		return np.vstack(x_rows), np.array(y_rows)

	def train(self, samples: Iterable[Tuple[str | Path, str]]) -> None:
		x_train, y_train = self.build_training_matrix(samples)
		self.pipeline.fit(x_train, y_train)
		self.is_trained = True

	def predict_from_image(self, image_path: str | Path) -> LightingPrediction:
		if not self.is_trained:
			self.train_builtin_pretrained()

		rgb = self._load_image_rgb(image_path)
		features = self.extract_features(rgb).reshape(1, -1)

		predicted_label = str(self.pipeline.predict(features)[0])
		probabilities = self.pipeline.predict_proba(features)[0]
		confidence = float(np.max(probabilities))
		brightness_score = float(np.mean(rgb))

		return LightingPrediction(
			label=predicted_label,
			confidence=confidence,
			brightness_score=brightness_score,
		)

	def predict_from_webcam(self, camera_index: int = 0, warmup_frames: int = 15) -> LightingPrediction:
		"""Capture a single frame from webcam and predict room lighting."""
		if not self.is_trained:
			self.train_builtin_pretrained()

		try:
			import cv2
		except ImportError as exc:
			raise RuntimeError("OpenCV is required for webcam mode. Install: pip install opencv-python") from exc

		cap = cv2.VideoCapture(camera_index)
		if not cap.isOpened():
			raise RuntimeError(f"Could not open webcam index {camera_index}.")

		frame = None
		for _ in range(max(1, warmup_frames)):
			ok, candidate = cap.read()
			if ok:
				frame = candidate

		cap.release()

		if frame is None:
			raise RuntimeError("Could not capture a valid frame from webcam.")

		rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
		rgb = np.array(Image.fromarray((rgb * 255).astype(np.uint8)).resize((224, 224)), dtype=np.float32) / 255.0
		features = self.extract_features(rgb).reshape(1, -1)

		predicted_label = str(self.pipeline.predict(features)[0])
		probabilities = self.pipeline.predict_proba(features)[0]
		confidence = float(np.max(probabilities))
		brightness_score = float(np.mean(rgb))

		return LightingPrediction(
			label=predicted_label,
			confidence=confidence,
			brightness_score=brightness_score,
		)

	def preview_webcam_and_predict(self, camera_index: int = 0) -> LightingPrediction:
		"""Show live webcam in OpenCV and estimate lighting continuously.

		Press Q to close preview and return the latest prediction.
		"""
		if not self.is_trained:
			self.train_builtin_pretrained()

		try:
			import cv2
		except ImportError as exc:
			raise RuntimeError("OpenCV is required for webcam mode. Install: pip install opencv-python") from exc

		cap = cv2.VideoCapture(camera_index)
		if not cap.isOpened():
			raise RuntimeError(f"Could not open webcam index {camera_index}.")

		window_name = "Room Lighting Detection"
		last_result: LightingPrediction | None = None

		while True:
			ok, frame = cap.read()
			if not ok:
				break

			rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
			rgb = np.array(Image.fromarray((rgb * 255).astype(np.uint8)).resize((224, 224)), dtype=np.float32) / 255.0
			features = self.extract_features(rgb).reshape(1, -1)

			predicted_label = str(self.pipeline.predict(features)[0])
			probabilities = self.pipeline.predict_proba(features)[0]
			confidence = float(np.max(probabilities))
			brightness_score = float(np.mean(rgb))

			last_result = LightingPrediction(
				label=predicted_label,
				confidence=confidence,
				brightness_score=brightness_score,
			)

			is_dark = predicted_label in ("dark", "dim")
			color = (0, 0, 255) if is_dark else (0, 200, 0)
			cv2.putText(
				frame,
				f"Lighting: {predicted_label} ({confidence:.2f})",
				(20, 40),
				cv2.FONT_HERSHEY_SIMPLEX,
				0.9,
				color,
				2,
				cv2.LINE_AA,
			)
			cv2.putText(
				frame,
				f"Brightness score: {brightness_score:.3f}",
				(20, 75),
				cv2.FONT_HERSHEY_SIMPLEX,
				0.75,
				(255, 255, 255),
				2,
				cv2.LINE_AA,
			)
			cv2.putText(
				frame,
				"Press Q to close",
				(20, 110),
				cv2.FONT_HERSHEY_SIMPLEX,
				0.65,
				(255, 255, 255),
				2,
				cv2.LINE_AA,
			)

			cv2.imshow(window_name, frame)
			if (cv2.waitKey(1) & 0xFF) == ord("q"):
				break

		cap.release()
		cv2.destroyAllWindows()

		if last_result is None:
			raise RuntimeError("Could not capture a valid frame from webcam.")

		return last_result

	def stream_webcam_headless(
		self,
		camera_index: int = 0,
		update_interval_seconds: float = 5.0,
		backend_base_url: str | None = None,
	) -> LightingPrediction:
		"""Run headless webcam detection; print JSON lines on each interval.

		If backend_base_url is set (e.g. http://127.0.0.1:3000), each emit also POSTs
		to /api/lighting/ml so GET /api/lighting/latest includes an ``ml`` object.
		"""
		if not self.is_trained:
			self.train_builtin_pretrained()

		try:
			import cv2
		except ImportError as exc:
			raise RuntimeError("OpenCV is required for webcam mode. Install: pip install opencv-python") from exc

		cap = cv2.VideoCapture(camera_index)
		if not cap.isOpened():
			raise RuntimeError(f"Could not open webcam index {camera_index}.")

		extra = f" push→{backend_base_url}/api/lighting/ml" if backend_base_url else ""
		print(
			f"Headless lighting detection started (camera={camera_index}, interval={update_interval_seconds:.1f}s){extra}. "
			"Press Ctrl+C to stop."
		)

		last_result: LightingPrediction | None = None
		last_emit = 0.0

		try:
			while True:
				ok, frame = cap.read()
				if not ok:
					print("Camera frame read failed.")
					break

				rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
				rgb = np.array(
					Image.fromarray((rgb * 255).astype(np.uint8)).resize((224, 224)),
					dtype=np.float32,
				) / 255.0
				features = self.extract_features(rgb).reshape(1, -1)

				predicted_label = str(self.pipeline.predict(features)[0])
				probabilities = self.pipeline.predict_proba(features)[0]
				confidence = float(np.max(probabilities))
				brightness_score = float(np.mean(rgb))

				last_result = LightingPrediction(
					label=predicted_label,
					confidence=confidence,
					brightness_score=brightness_score,
				)

				now = time.time()
				if (now - last_emit) >= max(0.5, update_interval_seconds):
					line = {
						"label": last_result.label,
						"confidence": round(last_result.confidence, 4),
						"brightness_score": round(last_result.brightness_score, 4),
					}
					print(json.dumps(line))
					if backend_base_url:
						push_lighting_ml_to_backend(
							backend_base_url,
							last_result.label,
							last_result.confidence,
							last_result.brightness_score,
						)
					last_emit = now
		except KeyboardInterrupt:
			print("Headless lighting detection stopped.")
		finally:
			cap.release()

		if last_result is None:
			raise RuntimeError("Could not capture a valid frame from webcam.")

		return last_result

	def save(self, model_path: str | Path) -> None:
		payload = {
			"pipeline": self.pipeline,
			"is_trained": self.is_trained,
		}
		joblib.dump(payload, model_path)

	@classmethod
	def load(cls, model_path: str | Path) -> "LightDetectionModel":
		payload = joblib.load(model_path)
		instance = cls()
		instance.pipeline = payload["pipeline"]
		instance.is_trained = payload["is_trained"]
		return instance

	@classmethod
	def pretrained(cls) -> "LightDetectionModel":
		"""Return an already-trained model instance."""
		instance = cls()
		instance.train_builtin_pretrained()
		return instance


def detect_room_lighting(
	image_path: str | Path,
	model_path: str | Path | None = None,
) -> LightingPrediction:
	"""One-shot prediction.

	If model_path is omitted, uses a built-in pretrained model.
	"""
	if model_path:
		model = LightDetectionModel.load(model_path)
	else:
		model = LightDetectionModel.pretrained()
	return model.predict_from_image(image_path)


if __name__ == "__main__":
	parser = argparse.ArgumentParser(description="Detect room lighting from an image.")
	parser.add_argument("--image", required=False, help="Path to room image")
	parser.add_argument("--model", required=False, help="Path to saved model file")
	parser.add_argument("--webcam", action="store_true", help="Capture from webcam instead of image file")
	parser.add_argument("--show-window", action="store_true", help="Show live webcam window in OpenCV")
	parser.add_argument(
		"--single-capture",
		action="store_true",
		help="In webcam mode, capture one frame and return a single prediction",
	)
	parser.add_argument("--camera-index", type=int, default=0, help="Webcam index for --webcam mode")
	parser.add_argument("--interval-seconds", type=float, default=5.0, help="Update interval in headless webcam mode")
	parser.add_argument(
		"--backend-url",
		default=None,
		help="Node base URL for ML ingest (e.g. http://127.0.0.1:3000). With headless --webcam, POSTs each interval to /api/lighting/ml; with --image or --single-capture, POSTs once.",
	)
	args = parser.parse_args()

	if args.model:
		model = LightDetectionModel.load(args.model)
	else:
		model = LightDetectionModel.pretrained()

	if args.webcam:
		if args.show_window:
			result = model.preview_webcam_and_predict(camera_index=args.camera_index)
		elif args.single_capture:
			result = model.predict_from_webcam(camera_index=args.camera_index)
		else:
			model.stream_webcam_headless(
				camera_index=args.camera_index,
				update_interval_seconds=args.interval_seconds,
				backend_base_url=args.backend_url,
			)
			raise SystemExit(0)
	elif args.image:
		result = model.predict_from_image(args.image)
	else:
		print("Use --webcam for live room detection or provide --image <path>.")
		raise SystemExit(1)

	out = {
		"label": result.label,
		"confidence": round(result.confidence, 4),
		"brightness_score": round(result.brightness_score, 4),
	}
	print(json.dumps(out, indent=2))
	if args.backend_url:
		push_lighting_ml_to_backend(
			args.backend_url,
			result.label,
			result.confidence,
			result.brightness_score,
		)
