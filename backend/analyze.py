import sys
import json
import numpy as np
import soundfile as sf

CHUNK_SECONDS = 10
TARGET_SR = 22050

def safe_float(value, digits=4):
    try:
        return round(float(value), digits)
    except Exception:
        return 0.0

def classify_level(value, low_threshold, high_threshold, low_label, mid_label, high_label):
    if value < low_threshold:
        return low_label
    if value > high_threshold:
        return high_label
    return mid_label

def simple_resample(signal, orig_sr, target_sr):
    if orig_sr == target_sr:
        return signal
    if len(signal) < 2:
        return signal

    duration = len(signal) / orig_sr
    new_length = max(1, int(duration * target_sr))

    old_x = np.linspace(0, 1, num=len(signal), endpoint=True)
    new_x = np.linspace(0, 1, num=new_length, endpoint=True)

    return np.interp(new_x, old_x, signal).astype(np.float32)

def spectral_metrics(signal, sr):
    spectrum = np.abs(np.fft.rfft(signal)).astype(np.float64) + 1e-12
    freqs = np.fft.rfftfreq(len(signal), d=1.0 / sr)

    total = np.sum(spectrum) + 1e-12
    centroid = float(np.sum(freqs * spectrum) / total)

    cumulative = np.cumsum(spectrum)
    threshold = 0.85 * cumulative[-1]
    rolloff_idx = min(np.searchsorted(cumulative, threshold), len(freqs) - 1)
    rolloff = float(freqs[rolloff_idx])

    geometric_mean = float(np.exp(np.mean(np.log(spectrum))))
    arithmetic_mean = float(np.mean(spectrum) + 1e-12)
    flatness = geometric_mean / arithmetic_mean

    low_energy = float(np.sum(spectrum[(freqs >= 20) & (freqs < 200)]))
    mid_energy = float(np.sum(spectrum[(freqs >= 200) & (freqs < 4000)]))
    high_energy = float(np.sum(spectrum[(freqs >= 4000) & (freqs < 11000)]))

    return {
        "centroid": centroid,
        "rolloff": rolloff,
        "flatness": flatness,
        "low_energy": low_energy,
        "mid_energy": mid_energy,
        "high_energy": high_energy,
        "total_energy": float(total)
    }

def frame_rms_db_values(signal, frame_size=1024, hop=512):
    values = []
    if len(signal) < frame_size:
        rms = np.sqrt(np.mean(np.square(signal)))
        values.append(20 * np.log10(max(rms, 1e-12)))
        return values

    for start in range(0, len(signal) - frame_size + 1, hop):
        frame = signal[start:start + frame_size]
        rms = np.sqrt(np.mean(np.square(frame)))
        values.append(20 * np.log10(max(rms, 1e-12)))
    return values

def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "ok": False,
            "error": "Aucun fichier fourni"
        }, ensure_ascii=False))
        sys.exit(1)

    filepath = sys.argv[1]

    try:
        info = sf.info(filepath)
        total_frames = info.frames
        orig_sr = info.samplerate
        channels = info.channels
        total_duration_sec = total_frames / orig_sr

        chunk_frames = max(1, int(CHUNK_SECONDS * orig_sr))

        global_peak = 0.0
        total_samples = 0
        sum_squares = 0.0

        centroid_weighted_sum = 0.0
        rolloff_weighted_sum = 0.0
        flatness_weighted_sum = 0.0
        centroid_weight = 0
        rolloff_weight = 0
        flatness_weight = 0

        total_low_energy = 0.0
        total_mid_energy = 0.0
        total_high_energy = 0.0
        total_spectral_energy = 0.0

        dynamic_rms_values = []

        stereo_corr_sum = 0.0
        stereo_corr_count = 0

        with sf.SoundFile(filepath, "r") as f:
            while True:
                data = f.read(frames=chunk_frames, dtype="float32", always_2d=True)
                if data.size == 0:
                    break

                mono = np.mean(data, axis=1)

                if orig_sr != TARGET_SR:
                    mono = simple_resample(mono, orig_sr, TARGET_SR)
                    sr = TARGET_SR
                else:
                    sr = orig_sr
                    mono = mono.astype(np.float32)

                if len(mono) == 0:
                    continue

                chunk_peak = float(np.max(np.abs(mono)))
                global_peak = max(global_peak, chunk_peak)

                sum_squares += float(np.sum(np.square(mono)))
                total_samples += int(len(mono))

                metrics = spectral_metrics(mono, sr)
                chunk_len = len(mono)

                centroid_weighted_sum += metrics["centroid"] * chunk_len
                rolloff_weighted_sum += metrics["rolloff"] * chunk_len
                flatness_weighted_sum += metrics["flatness"] * chunk_len
                centroid_weight += chunk_len
                rolloff_weight += chunk_len
                flatness_weight += chunk_len

                total_low_energy += metrics["low_energy"]
                total_mid_energy += metrics["mid_energy"]
                total_high_energy += metrics["high_energy"]
                total_spectral_energy += metrics["total_energy"]

                dynamic_rms_values.extend(frame_rms_db_values(mono))

                if channels >= 2 and data.shape[1] >= 2:
                    left = data[:, 0]
                    right = data[:, 1]
                    if len(left) > 1 and len(right) > 1:
                        corr = np.corrcoef(left, right)[0, 1]
                        if not np.isnan(corr):
                            stereo_corr_sum += float(corr)
                            stereo_corr_count += 1

        if total_samples == 0:
            raise ValueError("Fichier audio vide ou illisible")

        rms = np.sqrt(sum_squares / total_samples)
        rms_db = 20 * np.log10(max(rms, 1e-12))
        true_peak_db = 20 * np.log10(max(global_peak, 1e-12))

        integrated_lufs = rms_db - 0.5

        if dynamic_rms_values:
            dynamic_range_db = float(
                np.percentile(dynamic_rms_values, 95) - np.percentile(dynamic_rms_values, 10)
            )
        else:
            dynamic_range_db = float(true_peak_db - rms_db)

        centroid = centroid_weighted_sum / max(centroid_weight, 1)
        rolloff = rolloff_weighted_sum / max(rolloff_weight, 1)
        flatness = flatness_weighted_sum / max(flatness_weight, 1)

        low_ratio = total_low_energy / max(total_spectral_energy, 1e-12)
        mid_ratio = total_mid_energy / max(total_spectral_energy, 1e-12)
        high_ratio = total_high_energy / max(total_spectral_energy, 1e-12)

        stereo_width = "mono"
        if stereo_corr_count > 0:
            avg_corr = stereo_corr_sum / stereo_corr_count
            if avg_corr > 0.85:
                stereo_width = "narrow"
            elif avg_corr > 0.45:
                stereo_width = "medium"
            else:
                stereo_width = "wide"

        vocal_presence = classify_level(
            centroid,
            1400,
            2400,
            "dark",
            "good",
            "bright"
        )

        low_end = classify_level(
            low_ratio,
            0.18,
            0.32,
            "light",
            "balanced",
            "heavy"
        )

        brightness = classify_level(
            high_ratio,
            0.10,
            0.22,
            "dark",
            "balanced",
            "bright"
        )

        dynamics = classify_level(
            dynamic_range_db,
            8,
            14,
            "compressed",
            "controlled",
            "dynamic"
        )

        result = {
            "ok": True,
            "analysis": {
                "message": "Analyse audio complète par blocs terminée",
                "totalDurationSec": safe_float(total_duration_sec, 2),
                "sampleRate": int(TARGET_SR if orig_sr != TARGET_SR else orig_sr),
                "integratedLufs": safe_float(integrated_lufs, 2),
                "truePeakDb": safe_float(true_peak_db, 2),
                "rmsDb": safe_float(rms_db, 2),
                "dynamicRangeDb": safe_float(dynamic_range_db, 2),
                "dynamics": dynamics,
                "spectralCentroidHz": safe_float(centroid, 2),
                "spectralRolloffHz": safe_float(rolloff, 2),
                "spectralFlatness": safe_float(flatness, 4),
                "lowEnergyRatio": safe_float(low_ratio, 4),
                "midEnergyRatio": safe_float(mid_ratio, 4),
                "highEnergyRatio": safe_float(high_ratio, 4),
                "stereoWidth": stereo_width,
                "vocalPresence": vocal_presence,
                "lowEnd": low_end,
                "brightness": brightness,
                "analysisMode": "streaming_chunks"
            }
        }

        print(json.dumps(result, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({
            "ok": False,
            "error": str(e)
        }, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()
