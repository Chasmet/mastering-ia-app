import sys
import json
import numpy as np
import librosa
import pyloudnorm as pyln

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

def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "ok": False,
            "error": "Aucun fichier fourni"
        }))
        sys.exit(1)

    filepath = sys.argv[1]

    try:
        y, sr = librosa.load(filepath, sr=44100, mono=False)

        if y.ndim == 1:
            y_mono = y
            y_for_meter = y
        else:
            y_mono = librosa.to_mono(y)
            y_for_meter = y.T

        duration_sec = librosa.get_duration(y=y_mono, sr=sr)

        meter = pyln.Meter(sr)
        integrated_lufs = meter.integrated_loudness(y_for_meter)

        peak_linear = np.max(np.abs(y_mono))
        true_peak_db = 20 * np.log10(max(peak_linear, 1e-9))

        rms = np.sqrt(np.mean(np.square(y_mono)))
        rms_db = 20 * np.log10(max(rms, 1e-9))

        dynamic_range_db = true_peak_db - rms_db

        centroid = np.mean(librosa.feature.spectral_centroid(y=y_mono, sr=sr))
        rolloff = np.mean(librosa.feature.spectral_rolloff(y=y_mono, sr=sr, roll_percent=0.85))
        flatness = np.mean(librosa.feature.spectral_flatness(y=y_mono))

        spec = np.abs(librosa.stft(y_mono, n_fft=2048, hop_length=512))
        freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)

        total_energy = np.sum(spec) + 1e-9
        low_energy = np.sum(spec[(freqs >= 20) & (freqs < 200)])
        mid_energy = np.sum(spec[(freqs >= 200) & (freqs < 4000)])
        high_energy = np.sum(spec[(freqs >= 4000) & (freqs < 16000)])

        low_ratio = low_energy / total_energy
        mid_ratio = mid_energy / total_energy
        high_ratio = high_energy / total_energy

        stereo_width = "mono"
        if y.ndim > 1 and y.shape[0] == 2:
            left = y[0]
            right = y[1]
            corr = np.corrcoef(left, right)[0, 1]
            if np.isnan(corr):
                corr = 1.0

            if corr > 0.85:
                stereo_width = "narrow"
            elif corr > 0.45:
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
                "message": "Analyse audio réelle terminée",
                "durationSec": safe_float(duration_sec, 2),
                "sampleRate": int(sr),
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
                "brightness": brightness
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
