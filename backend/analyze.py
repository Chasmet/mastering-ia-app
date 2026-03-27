import sys
import json
import numpy as np
import soundfile as sf

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

def spectral_centroid(signal, sr):
    spectrum = np.abs(np.fft.rfft(signal))
    freqs = np.fft.rfftfreq(len(signal), d=1.0 / sr)
    total = np.sum(spectrum) + 1e-12
    return np.sum(freqs * spectrum) / total

def spectral_rolloff(signal, sr, roll_percent=0.85):
    spectrum = np.abs(np.fft.rfft(signal))
    freqs = np.fft.rfftfreq(len(signal), d=1.0 / sr)
    cumulative = np.cumsum(spectrum)
    threshold = roll_percent * cumulative[-1]
    index = np.searchsorted(cumulative, threshold)
    index = min(index, len(freqs) - 1)
    return freqs[index]

def spectral_flatness(signal):
    spectrum = np.abs(np.fft.rfft(signal)) + 1e-12
    geometric_mean = np.exp(np.mean(np.log(spectrum)))
    arithmetic_mean = np.mean(spectrum) + 1e-12
    return geometric_mean / arithmetic_mean

def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "ok": False,
            "error": "Aucun fichier fourni"
        }, ensure_ascii=False))
        sys.exit(1)

    filepath = sys.argv[1]

    try:
        data, sr = sf.read(filepath, always_2d=True)

        if data.size == 0:
            raise ValueError("Fichier audio vide")

        channels = data.shape[1]
        mono = np.mean(data, axis=1)

        duration_sec = len(mono) / sr

        peak_linear = np.max(np.abs(mono))
        true_peak_db = 20 * np.log10(max(peak_linear, 1e-12))

        rms = np.sqrt(np.mean(np.square(mono)))
        rms_db = 20 * np.log10(max(rms, 1e-12))

        # estimation simple du loudness
        integrated_lufs = rms_db - 0.5

        # dynamique simple
        frame_size = 2048
        hop = 1024
        frame_rms = []

        for start in range(0, max(len(mono) - frame_size, 1), hop):
            frame = mono[start:start + frame_size]
            if len(frame) == 0:
                continue
            frame_val = np.sqrt(np.mean(np.square(frame)))
            frame_rms.append(20 * np.log10(max(frame_val, 1e-12)))

        if frame_rms:
            dynamic_range_db = float(np.percentile(frame_rms, 95) - np.percentile(frame_rms, 10))
        else:
            dynamic_range_db = float(true_peak_db - rms_db)

        centroid = spectral_centroid(mono, sr)
        rolloff = spectral_rolloff(mono, sr, 0.85)
        flatness = spectral_flatness(mono)

        spectrum = np.abs(np.fft.rfft(mono))
        freqs = np.fft.rfftfreq(len(mono), d=1.0 / sr)

        total_energy = np.sum(spectrum) + 1e-12
        low_energy = np.sum(spectrum[(freqs >= 20) & (freqs < 200)])
        mid_energy = np.sum(spectrum[(freqs >= 200) & (freqs < 4000)])
        high_energy = np.sum(spectrum[(freqs >= 4000) & (freqs < 16000)])

        low_ratio = low_energy / total_energy
        mid_ratio = mid_energy / total_energy
        high_ratio = high_energy / total_energy

        stereo_width = "mono"
        if channels >= 2:
            left = data[:, 0]
            right = data[:, 1]
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
                "message": "Analyse audio réelle légère terminée",
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
