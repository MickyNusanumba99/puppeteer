# Penjelasan Fungsi - ocr.py

Dokumen ini menjelaskan setiap fungsi yang terdapat pada file `ocr.py`.


## Daftar Isi

1. [get_bbox_info](#1-get_bbox_info)
2. [detect_columns_kmeans](#2-detect_columns_kmeans)
3. [detect_paragraphs](#3-detect_paragraphs)
4. [process_ocr_result](#4-process_ocr_result)
5. [save_bounding_box_image](#5-save_bounding_box_image)
6. [retry_operation](#6-retry_operation)
7. [load_checkpoint](#7-load_checkpoint)
8. [save_checkpoint](#8-save_checkpoint)
9. [save_text_file](#9-save_text_file)
10. [Main Logic](#10-main-logic)

---

## 1. `get_bbox_info`

```python
def get_bbox_info(detection)
```

**Tujuan:** Mengekstrak informasi posisi dan dimensi dari satu hasil deteksi EasyOCR.

**Parameter:**

- `detection` - Satu item hasil dari `reader.readtext()`, berisi `[bbox, text, confidence]`.

**Return:** Dictionary berisi:

| Key          | Tipe  | Deskripsi                               |
| ------------ | ----- | --------------------------------------- |
| `bbox`       | list  | Koordinat 4 titik sudut bounding box    |
| `x_left`     | float | Posisi X paling kiri                    |
| `x_right`    | float | Posisi X paling kanan                   |
| `x_center`   | float | Titik tengah horizontal                 |
| `y_top`      | float | Posisi Y paling atas                    |
| `y_bottom`   | float | Posisi Y paling bawah                   |
| `height`     | float | Tinggi bounding box                     |
| `width`      | float | Lebar bounding box                      |
| `text`       | str   | Teks yang terdeteksi                    |
| `confidence` | float | Tingkat kepercayaan deteksi (0.0 - 1.0) |

**Cara Kerja:**
EasyOCR mengembalikan bounding box dalam format 4 titik `[[x1,y1], [x2,y2], [x3,y3], [x4,y4]]` yang merepresentasikan sudut top-left, top-right, bottom-right, dan bottom-left. Fungsi ini mengkonversi format tersebut menjadi representasi kotak sederhana (x_left, x_right, y_top, y_bottom) dengan menghitung nilai minimum dan maksimum dari koordinat X dan Y.

---

## 2. `detect_columns_kmeans`

```python
def detect_columns_kmeans(detections, max_columns=4)
```

**Tujuan:** Mendeteksi jumlah kolom teks pada gambar koran menggunakan algoritma KMeans clustering.

**Parameter:**

- `detections` - List hasil deteksi dari EasyOCR.
- `max_columns` - Jumlah kolom maksimal yang dicoba (default: 4).

**Return:** List of list, di mana setiap sub-list berisi info bounding box untuk satu kolom. Kolom diurutkan dari kiri ke kanan, dan teks dalam setiap kolom diurutkan dari atas ke bawah.

**Cara Kerja:**

1. **Filter:** Hanya mengambil deteksi dengan confidence > 0.4 untuk menghilangkan noise.
2. **Ekstraksi fitur:** Mengambil nilai `x_center` dari setiap deteksi sebagai fitur 1 dimensi.
3. **Pencarian K optimal:** Menjalankan KMeans untuk k = 2 sampai `max_columns`, lalu menghitung silhouette score untuk setiap k. Nilai k dengan silhouette score tertinggi dipilih sebagai jumlah kolom terbaik.
4. **Clustering final:** Menjalankan KMeans dengan k optimal dan mengelompokkan setiap deteksi ke cluster/kolom yang sesuai.
5. **Pengurutan:** Setiap kolom diurutkan berdasarkan posisi vertikal (atas ke bawah), dan kolom-kolom diurutkan berdasarkan posisi horizontal (kiri ke kanan).

**Catatan:** Jika jumlah deteksi kurang dari 5, fungsi mengembalikan semua teks sebagai 1 kolom tanpa melakukan clustering.

---

## 3. `detect_paragraphs`

```python
def detect_paragraphs(column_lines)
```

**Tujuan:** Mengelompokkan baris-baris teks dalam satu kolom menjadi paragraf berdasarkan jarak vertikal.

**Parameter:**

- `column_lines` - List info bounding box untuk satu kolom (output dari `detect_columns_kmeans`).

**Return:** List of string, di mana setiap string adalah satu paragraf utuh.

**Cara Kerja:**

1. **Hitung rata-rata tinggi baris:** Digunakan sebagai baseline untuk menentukan jarak normal antar baris.
2. **Iterasi baris:** Untuk setiap pasangan baris berturutan, hitung gap vertikal (jarak antara `y_bottom` baris sebelumnya dan `y_top` baris berikutnya).
3. **Threshold:** Jika gap lebih besar dari 2x rata-rata tinggi baris, maka dianggap sebagai pemisah paragraf. Baris-baris sebelumnya digabung menjadi satu paragraf, dan baris baru memulai paragraf baru.
4. **Penggabungan:** Teks dalam satu paragraf digabung dengan spasi.

---

## 4. `process_ocr_result`

```python
def process_ocr_result(detections)
```

**Tujuan:** Fungsi utama yang mengorkestrasi seluruh proses pengolahan hasil OCR -- dari deteksi kolom, deteksi paragraf, hingga menghasilkan teks akhir yang terstruktur.

**Parameter:**

- `detections` - List lengkap hasil deteksi dari EasyOCR.

**Return:** Tuple berisi 3 elemen:

| Index | Tipe | Deskripsi                                                                             |
| ----- | ---- | ------------------------------------------------------------------------------------- |
| 0     | str  | `full_text` - Teks lengkap yang sudah dirapikan (per kolom, per paragraf)             |
| 1     | list | `raw_texts` - List dictionary `{text, confidence}` untuk setiap baris                 |
| 2     | list | `columns` - Struktur kolom yang terdeteksi (digunakan untuk visualisasi bounding box) |

**Alur Proses:**

```
detections
    |
    v
detect_columns_kmeans()  -->  [kolom1, kolom2, kolom3, ...]
    |
    v (untuk setiap kolom)
detect_paragraphs()  -->  ["paragraf1", "paragraf2", ...]
    |
    v
Gabung semua paragraf  -->  full_text (dipisah \n\n)
```

---

## 5. `save_bounding_box_image`

```python
def save_bounding_box_image(img_path, columns)
```

**Tujuan:** Membuat dan menyimpan gambar anotasi yang menampilkan bounding box berwarna untuk setiap kolom yang terdeteksi.

**Parameter:**

- `img_path` - Path ke gambar asli.
- `columns` - Struktur kolom dari `process_ocr_result`.

**Return:** Path ke gambar bounding box yang disimpan, atau `None` jika gagal.

**Cara Kerja:**

1. **Baca gambar** menggunakan OpenCV.
2. **Buat overlay** (salinan gambar untuk efek semi-transparan).
3. **Gambar bounding box:** Untuk setiap kolom, gunakan warna berbeda:
   - Kolom 1: Merah
   - Kolom 2: Biru
   - Kolom 3: Hijau
   - Kolom 4: Orange
   - Kolom 5: Magenta
   - Kolom 6: Cyan
4. **Kotak semi-transparan** digambar pada overlay, **border tegas** digambar pada gambar asli.
5. **Label kolom** ditambahkan di atas bounding box pertama setiap kolom.
6. **Blend:** Overlay dan gambar asli dicampur dengan alpha = 0.15 untuk efek transparan.
7. **Simpan** ke direktori `output/bounding-box/` dengan prefix `bbox_`.

---

## 6. `retry_operation`

```python
def retry_operation(operation, operation_name, max_retries=MAX_RETRIES)
```

**Tujuan:** Wrapper untuk menjalankan operasi yang rentan gagal (misalnya OCR) dengan mekanisme retry otomatis.

**Parameter:**

- `operation` - Fungsi (callable) yang akan dijalankan.
- `operation_name` - Nama operasi untuk logging.
- `max_retries` - Jumlah maksimal percobaan (default: 3).

**Return:** Hasil dari `operation()` jika berhasil.

**Error yang di-retry:**

- timeout
- connection
- network
- io error
- read

Error selain di atas langsung di-raise tanpa retry. Jeda antar retry ditentukan oleh `RETRY_DELAY` (default: 5 detik).

---

## 7. `load_checkpoint`

```python
def load_checkpoint()
```

**Tujuan:** Membaca file checkpoint untuk melanjutkan proses OCR yang sebelumnya terhenti.

**Return:** Dictionary checkpoint berisi `last_index` dan `total_items`, atau `None` jika tidak ada checkpoint.

**Cara Kerja:** Membaca file `ocr_checkpoint.json`. Jika file tidak ada atau corrupt, mengembalikan `None` sehingga proses dimulai dari awal.

---

## 8. `save_checkpoint`

```python
def save_checkpoint(index, total)
```

**Tujuan:** Menyimpan progres OCR ke file checkpoint agar bisa dilanjutkan jika proses terhenti.

**Parameter:**

- `index` - Index item terakhir yang berhasil diproses.
- `total` - Total jumlah item.

**Data yang disimpan:** `last_index`, `total_items`, dan `last_updated`.

---

## 9. `save_text_file`

```python
def save_text_file(img_path, full_text, title="", date="", media="")
```

**Tujuan:** Menyimpan hasil OCR sebagai file teks (.txt) yang mudah dibaca, lengkap dengan metadata.

**Parameter:**

- `img_path` - Path gambar asli (digunakan untuk penamaan file).
- `full_text` - Teks hasil OCR yang sudah diproses.
- `title` - Judul berita (opsional).
- `date` - Tanggal berita (opsional).
- `media` - Nama media (opsional).

**Return:** Path ke file .txt yang disimpan.

**Format Output:**

```
Judul : [judul berita]
Tanggal: [tanggal]
Media  : [nama media]
==================================================

[isi teks hasil OCR per kolom dan paragraf]
```

---

## 10. Main Logic

Bagian utama script yang tidak dibungkus dalam fungsi (berjalan saat file dieksekusi).

**Alur:**

1. **Load data:** Membaca `metadata.json` yang berisi daftar gambar dan metadata berita.
2. **Load checkpoint:** Mengecek apakah ada proses OCR yang terhenti sebelumnya.
3. **Load hasil sebelumnya:** Jika `metadata_ocr.json` sudah ada, memuat hasil OCR yang sudah selesai agar tidak diproses ulang.
4. **Loop utama:** Untuk setiap item:
   - Skip jika sudah punya hasil OCR.
   - Skip jika file gambar tidak ditemukan.
   - Jalankan OCR dengan `reader.readtext()`.
   - Proses hasil dengan `process_ocr_result()`.
   - Simpan file .txt dengan `save_text_file()`.
   - Simpan visualisasi bounding box dengan `save_bounding_box_image()`.
   - Simpan checkpoint dan auto-save JSON.
5. **Finalisasi:** Simpan hasil akhir ke `metadata_ocr.json`, hapus checkpoint.

**Output yang Dihasilkan:**

| File/Direktori                   | Deskripsi                                                     |
| -------------------------------- | ------------------------------------------------------------- |
| `output/metadata_ocr.json`       | JSON lengkap dengan data OCR (`ocr_text` dan `ocr_full_text`) |
| `output/texts/*.txt`             | File teks per gambar dengan metadata dan teks terstruktur     |
| `output/bounding-box/bbox_*.jpg` | Gambar anotasi bounding box berwarna per kolom                |

---

## Konstanta dan Konfigurasi

| Konstanta         | Nilai                           | Deskripsi                                      |
| ----------------- | ------------------------------- | ---------------------------------------------- |
| `MAX_RETRIES`     | 3                               | Jumlah maksimal percobaan ulang jika OCR gagal |
| `RETRY_DELAY`     | 5                               | Jeda (detik) antar percobaan ulang             |
| `CHECKPOINT_FILE` | `../output/ocr_checkpoint.json` | Lokasi file checkpoint                         |
| `OUTPUT_FILE`     | `../output/metadata_ocr.json`   | Lokasi file output JSON                        |
| `INPUT_FILE`      | `../output/metadata.json`       | Lokasi file input metadata                     |
| `TEXTS_DIR`       | `../output/texts`               | Direktori output file teks                     |
| `BBOX_DIR`        | `../output/bounding-box`        | Direktori output gambar bounding box           |

---

## Dependencies

| Library               | Kegunaan                                                   |
| --------------------- | ---------------------------------------------------------- |
| `easyocr`             | Engine OCR utama (support Bahasa Indonesia dan Inggris)    |
| `opencv-python` (cv2) | Membaca gambar dan menggambar bounding box                 |
| `numpy`               | Operasi array untuk KMeans dan pengolahan data             |
| `scikit-learn`        | KMeans clustering dan silhouette score untuk deteksi kolom |
