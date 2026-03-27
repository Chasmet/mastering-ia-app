import sys
import os
import json
import uuid
from pathlib import Path
import soundfile as sf

CHUNK_SECONDS = 10

def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "ok": False,
            "error": "Aucun fichier audio fourni"
        }, ensure_ascii=False))
        sys.exit(1)

    input_path = sys.argv[1]

    if not os.path.exists(input_path):
      print(json.dumps({
          "ok": False,
          "error": "Fichier introuvable"
      }, ensure_ascii=False))
      sys.exit(1)

    try:
        info = sf.info(input_path)
        sample_rate = info.samplerate
        channels = info.channels
        total_frames = info.frames
        total_duration_sec = total_frames / sample_rate

        chunk_frames = int(CHUNK_SECONDS * sample_rate)

        session_id = str(uuid.uuid4())
        output_dir = Path("/tmp") / f"chunks_{session_id}"
        output_dir.mkdir(parents=True, exist_ok=True)

        manifest = {
            "ok": True,
            "sessionId": session_id,
            "inputFile": os.path.basename(input_path),
            "sampleRate": sample_rate,
            "channels": channels,
            "chunkSeconds": CHUNK_SECONDS,
            "totalDurationSec": round(total_duration_sec, 2),
            "chunks": []
        }

        with sf.SoundFile(input_path, "r") as audio_file:
            chunk_index = 0
            start_frame = 0

            while True:
                data = audio_file.read(frames=chunk_frames, dtype="float32", always_2d=True)
                if data.size == 0:
                    break

                chunk_start_sec = start_frame / sample_rate
                chunk_duration_sec = len(data) / sample_rate
                chunk_end_sec = chunk_start_sec + chunk_duration_sec

                chunk_filename = f"chunk_{chunk_index:04d}.wav"
                chunk_path = output_dir / chunk_filename

                sf.write(str(chunk_path), data, sample_rate)

                manifest["chunks"].append({
                    "index": chunk_index,
                    "filename": chunk_filename,
                    "path": str(chunk_path),
                    "startSec": round(chunk_start_sec, 2),
                    "endSec": round(chunk_end_sec, 2),
                    "durationSec": round(chunk_duration_sec, 2)
                })

                start_frame += len(data)
                chunk_index += 1

        manifest["chunkCount"] = len(manifest["chunks"])

        manifest_path = output_dir / "manifest.json"
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

        manifest["manifestPath"] = str(manifest_path)
        manifest["outputDir"] = str(output_dir)

        print(json.dumps(manifest, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({
            "ok": False,
            "error": str(e)
        }, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()
