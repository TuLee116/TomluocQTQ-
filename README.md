# Tóm lược Quy trình – Quy định · Chuẩn Thủ lĩnh, Vững Quy trình

Bản đóng gói để tự host (GitHub + Railway). Giao diện và tính năng giống hệt bản trên Claude:
đăng nhập bằng tài khoản, nội dung mã hoá AES, mục II Tài liệu chỉ admin/Ban Kiểm soát mở được,
chỉnh sửa và đồng bộ nội dung, thêm tài khoản, mỗi tài khoản chỉ đăng nhập 1 phiên.

## Cấu trúc

| Thư mục / tệp | Vai trò |
|---|---|
| `server.js` | Máy chủ Node (không cần cài thư viện). Phục vụ trang và API lưu dữ liệu |
| `claude-shim.js` | Lớp tương thích thay cho môi trường Claude (db, phiên, tải tệp) |
| `public/index.html` | Trang chính – **toàn bộ nội dung đã được mã hoá sẵn** |
| `public/f/` | Tệp hệ thống tài liệu mục II (đã mã hoá) |
| `public/pdfjs/` | Trình xem PDF |
| `data/` | Dữ liệu phát sinh khi chạy (không đưa lên GitHub) |

Dữ liệu đồng bộ được lưu trong `DATA_DIR`:
- `docs/content__overrides.json` – nội dung đã chỉnh sửa
- `docs/content__accounts.json` – tài khoản thêm mới (đã mã hoá, chỉ lưu mã băm)
- `docs/content__files.json` + `blobs/` – tệp admin tải lên
- `logs/login.jsonl` – nhật ký đăng nhập (thành công/thất bại/bị buộc đăng xuất), giữ ~5.000 dòng mới nhất

## Quản trị hệ thống (chỉ vinhtu)

Nút **🛡 Quản trị hệ thống** trong menu, chỉ hiện với vinhtu:
- **Nhật ký đăng nhập**: thời gian, tên đăng nhập, vai trò, IP (header `x-forwarded-for`), trình duyệt; lọc, tìm, tải CSV. Không bao giờ ghi mật khẩu.
- **Tài khoản**: vinhtu + tài khoản thêm bằng nút (đọc `content/accounts`), lần đăng nhập gần nhất, trạng thái đang mở.
- **Phiên đang mở**: tài khoản, IP, trình duyệt, giờ đăng nhập, hoạt động cuối; nút **Đăng xuất** buộc phiên thoát ngay (qua `/api/watch`).

API `/api/admin/logs`, `/api/admin/sessions`, `/api/admin/kick` chỉ chạy khi header `x-tmn-w` khớp `SUPER_PASS`.

## Biến môi trường

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `SUPER_PASS` | Có | Mật khẩu tài khoản Ban Kiểm soát (vinhtu) – quyền lưu nội dung, tải tệp |
| `ADMIN_PASS` | Có | Mật khẩu tài khoản admin – quyền thêm tài khoản |
| `DATA_DIR` | Có trên Railway | Đặt `/data` và gắn Volume vào `/data` |
| `PORT` | Không | Railway tự cấp |

> Mật khẩu **phải trùng** với mật khẩu đang dùng để đăng nhập, vì máy chủ dùng nó để xác thực quyền ghi.
> Mật khẩu không nằm trong mã nguồn – chỉ đặt trong Railway.

## Đưa lên GitHub

```bash
cd tmn-quytrinh
git init            # (bỏ qua nếu đã có sẵn thư mục .git)
git add .
git commit -m "TMN Quy trình"
git branch -M main
git remote add origin https://github.com/<tai-khoan>/tmn-quytrinh.git
git push -u origin main
```

Nên để repo ở chế độ **Private**. Nội dung đã mã hoá nên kể cả lộ repo cũng không đọc được nếu không có mật khẩu,
nhưng Private vẫn an toàn hơn.

## Triển khai trên Railway

1. Railway → **New Project → Deploy from GitHub repo** → chọn `tmn-quytrinh`.
2. Tab **Variables**: thêm `SUPER_PASS`, `ADMIN_PASS`, `DATA_DIR=/data`.
3. Chuột phải vào service → **Attach Volume** → Mount path: `/data`.
   *Không gắn Volume thì mỗi lần deploy lại sẽ mất nội dung đã sửa và tài khoản đã thêm.*
4. Tab **Settings → Networking → Generate Domain** để có đường link (hoặc gắn tên miền riêng).
5. Mở link, đăng nhập thử bằng vinhtu.

Railway tự nhận Node qua `package.json`, lệnh chạy `node server.js`, kiểm tra sống tại `/healthz`.

## Chạy thử trên máy

```bash
SUPER_PASS=... ADMIN_PASS=... node server.js
# mở http://localhost:3000
```

Windows (PowerShell):
```powershell
$env:SUPER_PASS="..."; $env:ADMIN_PASS="..."; node server.js
```

## Khác biệt so với bản trên Claude

- Thêm tài khoản: admin và Ban Kiểm soát thêm là **đăng nhập được ngay**, không cần chờ đồng bộ.
- Chỉnh sửa của Ban Kiểm soát lưu thẳng lên máy chủ, người xem nhận bản mới sau ~4 giây.
- Các tệp đã tải lên kho Claude trước đây (19 tệp + 3 tệp ẩn) **không chuyển sang được** – cần tải lại từ bản gốc
  qua nút tải lên trong mục II. Tài liệu hệ thống (thư mục `public/f/`) đã có đủ.
- Toàn bộ chỉnh sửa nội dung và tài khoản đến thời điểm đóng gói đã được gộp sẵn vào `public/index.html`,
  nên `data/` ban đầu để trống.

## Sao lưu

Tải định kỳ thư mục `/data` trên Volume (Railway → Volume → Backups, hoặc bật backup tự động).
