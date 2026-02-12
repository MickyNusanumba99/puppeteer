import easyocr
import json
import os
import time
import cv2
import numpy as np
from collections import defaultdict

MAX_RETRIES = 3
RETRY_DELAY = 5

# Inisialisasi EasyOCR Reader (support Bahasa Indonesia dan Inggris)
reader = easyocr.Reader(['id', 'en'], gpu=False)

CHECKPOINT_FILE = "../output/ocr_checkpoint.json"
OUTPUT_FILE = "../output/metadata_ocr.json"
INPUT_FILE = "../output/metadata.json"
TEXTS_DIR = "../output/texts"
BBOX_DIR = "../output/bounding-box"

# Column Detection & Paragraph Detection
def get_bbox_info(detection):
    """Ambil info posisi dari bounding box EasyOCR.
    EasyOCR bbox format: [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
    (top-left, top-right, bottom-right, bottom-left)
    """
    bbox = detection[0]
    x_left = min(p[0] for p in bbox)
    x_right = max(p[0] for p in bbox)
    y_top = min(p[1] for p in bbox)
    y_bottom = max(p[1] for p in bbox)
    x_center = (x_left + x_right) / 2
    height = y_bottom - y_top
    return {
        "bbox": bbox,
        "x_left": x_left,
        "x_right": x_right,
        "x_center": x_center,
        "y_top": y_top,
        "y_bottom": y_bottom,
        "height": height,
        "text": detection[1],
        "confidence": float(detection[2])
    }


def detect_columns(detections):
    """Deteksi kolom berdasarkan posisi X dari bounding box.
    Menggunakan clustering sederhana pada x_center.
    """
    if not detections:
        return []

    infos = [get_bbox_info(d) for d in detections]

    all_x_left = [info["x_left"] for info in infos]
    all_x_right = [info["x_right"] for info in infos]
    img_width = max(all_x_right) - min(all_x_left) if all_x_right else 1

    col_threshold = img_width * 0.20

    sorted_by_x = sorted(infos, key=lambda i: i["x_center"])

    columns = []
    current_col = [sorted_by_x[0]]

    for info in sorted_by_x[1:]:
        col_avg_x = sum(i["x_center"] for i in current_col) / len(current_col)
        if abs(info["x_center"] - col_avg_x) <= col_threshold:
            current_col.append(info)
        else:
            columns.append(current_col)
            current_col = [info]

    columns.append(current_col)

    for col in columns:
        col.sort(key=lambda i: i["y_top"])

    columns.sort(key=lambda col: sum(i["x_center"] for i in col) / len(col))

    return columns


def detect_paragraphs(column_lines):
    """Deteksi paragraf dalam satu kolom berdasarkan jarak vertikal (Y gap).
    Jika gap antar baris > 1.5x rata-rata tinggi baris → paragraf baru.
    """
    if not column_lines:
        return []

    # Hitung rata-rata tinggi baris
    heights = [line["height"] for line in column_lines]
    avg_height = sum(heights) / len(heights) if heights else 20

    paragraphs = []
    current_paragraph = [column_lines[0]["text"]]

    for j in range(1, len(column_lines)):
        prev = column_lines[j - 1]
        curr = column_lines[j]

        # Gap antara bottom baris sebelumnya dan top baris sekarang
        gap = curr["y_top"] - prev["y_bottom"]

        # Jika gap besar → paragraf baru
        if gap > avg_height * 1.5:
            paragraphs.append(" ".join(current_paragraph))
            current_paragraph = [curr["text"]]
        else:
            current_paragraph.append(curr["text"])

    # Tambahkan paragraf terakhir
    if current_paragraph:
        paragraphs.append(" ".join(current_paragraph))

    return paragraphs


def process_ocr_result(detections):
    """Proses hasil OCR: deteksi kolom, deteksi paragraf, gabungkan jadi teks rapi."""
    if not detections:
        return "", [], []

    # Deteksi kolom
    columns = detect_columns(detections)

    # Proses tiap kolom → deteksi paragraf
    all_paragraphs = []
    raw_texts = []

    for col_lines in columns:
        paragraphs = detect_paragraphs(col_lines)
        all_paragraphs.extend(paragraphs)

        # Simpan raw text dengan confidence untuk JSON
        for line in col_lines:
            raw_texts.append({
                "text": line["text"],
                "confidence": line["confidence"]
            })

    # Gabungkan paragraf jadi teks lengkap
    full_text = "\n\n".join(all_paragraphs)

    return full_text, raw_texts, columns


def save_bounding_box_image(img_path, columns):
    """Simpan gambar dengan bounding box berwarna per kolom."""
    os.makedirs(BBOX_DIR, exist_ok=True)

    img = cv2.imread(img_path)
    if img is None:
        print(f"   ⚠️  Tidak bisa membaca gambar untuk bbox: {img_path}")
        return None

    # Warna berbeda untuk tiap kolom (BGR format)
    COLORS = [
        (0, 0, 255),      # Merah - Kolom 1
        (255, 0, 0),      # Biru - Kolom 2
        (0, 180, 0),      # Hijau - Kolom 3
        (0, 165, 255),    # Orange - Kolom 4
        (255, 0, 255),    # Magenta - Kolom 5
        (255, 255, 0),    # Cyan - Kolom 6
    ]

    overlay = img.copy()

    for col_idx, col_lines in enumerate(columns):
        color = COLORS[col_idx % len(COLORS)]

        for line_info in col_lines:
            # Gambar bounding box
            x1 = int(line_info["x_left"])
            y1 = int(line_info["y_top"])
            x2 = int(line_info["x_right"])
            y2 = int(line_info["y_bottom"])

            # Kotak semi-transparan
            cv2.rectangle(overlay, (x1, y1), (x2, y2), color, -1)

            # Border tegas
            cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)

        # Label kolom di atas kolom pertama
        if col_lines:
            first = col_lines[0]
            label_x = int(first["x_left"])
            label_y = max(int(first["y_top"]) - 15, 20)
            cv2.putText(img, f"Kolom {col_idx + 1}",
                        (label_x, label_y),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)

    # Blend overlay (semi-transparan)
    alpha = 0.15
    img = cv2.addWeighted(overlay, alpha, img, 1 - alpha, 0)

    # Simpan
    basename = os.path.basename(img_path)
    bbox_path = os.path.join(BBOX_DIR, f"bbox_{basename}")
    cv2.imwrite(bbox_path, img)

    return bbox_path


# ============================================================
# RETRY, CHECKPOINT, & MAIN LOGIC
# ============================================================

def retry_operation(operation, operation_name, max_retries=MAX_RETRIES):
    """Retry wrapper untuk operasi yang bisa gagal."""
    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            return operation()
        except Exception as error:
            last_error = error
            error_msg = str(error).lower()

            is_retryable = (
                'timeout' in error_msg or
                'connection' in error_msg or
                'network' in error_msg or
                'io error' in error_msg or
                'read' in error_msg
            )

            if is_retryable and attempt < max_retries:
                print(f"⚠️  {operation_name} gagal (attempt {attempt}/{max_retries}): {error}")
                print(f"🔄 Retry dalam {RETRY_DELAY} detik...")
                time.sleep(RETRY_DELAY)
            elif not is_retryable:
                raise error

    print(f"❌ {operation_name} gagal setelah {max_retries} percobaan")
    raise last_error


def load_checkpoint():
    if os.path.exists(CHECKPOINT_FILE):
        try:
            with open(CHECKPOINT_FILE, "r", encoding="utf-8") as f:
                checkpoint = json.load(f)
                print(f"📋 Checkpoint OCR ditemukan! Melanjutkan dari index {checkpoint['last_index'] + 1}")
                return checkpoint
        except Exception as e:
            print(f"⚠️  Error membaca checkpoint: {e}")
            return None
    return None


def save_checkpoint(index, total):
    checkpoint = {
        "last_index": index,
        "total_items": total,
        "last_updated": str(os.times())
    }
    with open(CHECKPOINT_FILE, "w", encoding="utf-8") as f:
        json.dump(checkpoint, f, ensure_ascii=False, indent=2)


def save_text_file(img_path, full_text, title="", date="", media=""):
    """Simpan teks hasil OCR ke file .txt"""
    os.makedirs(TEXTS_DIR, exist_ok=True)

    # Nama file dari nama gambar
    basename = os.path.splitext(os.path.basename(img_path))[0]
    txt_path = os.path.join(TEXTS_DIR, f"{basename}.txt")

    with open(txt_path, "w", encoding="utf-8") as f:
        # Header metadata
        if title:
            f.write(f"Judul : {title}\n")
        if date:
            f.write(f"Tanggal: {date}\n")
        if media:
            f.write(f"Media  : {media}\n")
        if title or date or media:
            f.write(f"{'=' * 50}\n\n")

        # Isi teks
        f.write(full_text)
        f.write("\n")

    return txt_path


# ============================================================
# MAIN
# ============================================================

# Load data dan checkpoint
with open(INPUT_FILE, encoding="utf-8") as f:
    data = json.load(f)

checkpoint = load_checkpoint()

# Load hasil OCR yang sudah ada (jika ada)
if os.path.exists(OUTPUT_FILE):
    try:
        with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
            existing_data = json.load(f)
            for i, item in enumerate(existing_data):
                if i < len(data) and "ocr_text" in item:
                    data[i]["ocr_text"] = item["ocr_text"]
                    if "ocr_full_text" in item:
                        data[i]["ocr_full_text"] = item["ocr_full_text"]
    except Exception as e:
        print(f"⚠️  Error membaca file output yang ada: {e}")

start_index = checkpoint["last_index"] + 1 if checkpoint else 0
total_items = len(data)

print(f"🚀 Memulai OCR dari item {start_index + 1} dari total {total_items} item")

for i in range(start_index, total_items):
    item = data[i]
    img_path = item["local_image"]

    # Skip jika sudah ada OCR text
    if "ocr_text" in item:
        print(f"⏭️  Item {i + 1}/{total_items}: Sudah di-OCR, skip")
        continue

    if not os.path.exists(img_path):
        print(f"⚠️  Item {i + 1}/{total_items}: File tidak ditemukan - {img_path}")
        item["ocr_text"] = []
        item["ocr_full_text"] = ""
        continue

    print(f"🔍 Item {i + 1}/{total_items}: Melakukan OCR pada {os.path.basename(img_path)}")

    try:
        def do_ocr():
            return reader.readtext(img_path)

        detections = retry_operation(do_ocr, f"OCR item {i + 1}")

        # Proses dengan column detection & paragraph detection
        full_text, raw_texts, columns = process_ocr_result(detections)

        item["ocr_text"] = raw_texts
        item["ocr_full_text"] = full_text

        # Simpan file .txt
        txt_path = save_text_file(
            img_path,
            full_text,
            title=item.get("title", ""),
            date=item.get("date", ""),
            media=item.get("media", "")
        )
        print(f"   📄 Tersimpan: {os.path.basename(txt_path)}")

        # Simpan bounding box visualization
        bbox_path = save_bounding_box_image(img_path, columns)
        if bbox_path:
            print(f"   🖼️  Bounding box: {os.path.basename(bbox_path)}")

        # Simpan progress
        save_checkpoint(i, total_items)

        # Auto-save JSON
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    except Exception as e:
        print(f"❌ Error OCR pada item {i + 1}: {e}")
        item["ocr_text"] = []
        item["ocr_full_text"] = ""
        continue

# Simpan hasil final
with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

# Hapus checkpoint jika semua selesai
if os.path.exists(CHECKPOINT_FILE):
    os.remove(CHECKPOINT_FILE)
    print("🗑️  Checkpoint OCR dihapus (proses selesai)")

print(f"✅ OCR selesai! Total {total_items} item berhasil diproses")
print(f"📁 File teks tersimpan di: {os.path.abspath(TEXTS_DIR)}")
print(f"🖼️  Bounding box tersimpan di: {os.path.abspath(BBOX_DIR)}")
