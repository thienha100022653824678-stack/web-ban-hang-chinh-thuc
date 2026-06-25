-- Kịch bản khởi tạo database cho hệ thống Bán Hàng / Đăng Ký Khóa Học
-- Sao chép toàn bộ nội dung này và chạy trong Supabase SQL Editor

-- 1. Tạo bảng courses (Khóa học)
CREATE TABLE IF NOT EXISTS courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  price TEXT,
  image_url TEXT,
  description TEXT,
  teacher_name TEXT,
  active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  raw_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Tạo bảng orders (Đơn đăng ký / Học viên)
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_slug TEXT NOT NULL,
  course_title TEXT,
  customer_name TEXT,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  proof_image_url TEXT,
  status TEXT DEFAULT 'Chờ duyệt',
  note TEXT,
  raw_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Tạo index để tối ưu truy vấn
CREATE INDEX IF NOT EXISTS idx_courses_slug ON courses(slug);
CREATE INDEX IF NOT EXISTS idx_orders_course_slug ON orders(course_slug);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- 4. Chèn dữ liệu mẫu cho khóa học mặc định (donut) và một số khóa học ví dụ
INSERT INTO courses (slug, title, price, image_url, active, sort_order, raw_data)
VALUES (
  'donut',
  'Pinterest Food Studio — Bánh Donut',
  '199.000đ',
  'https://images.unsplash.com/photo-1530601761230-c71509743e42?auto=format&fit=crop&q=80&w=800',
  true,
  1,
  '{
    "bankName": "MB Bank (Ngân hàng Quân đội)",
    "bankAccount": "0999999999",
    "bankOwner": "NGUYEN VAN A",
    "transferNote": "DONUT GMAIL_CUA_BAN",
    "qrImageUrl": "https://img.vietqr.io/image/MB-0999999999-compact.png?amount=199000&addInfo=DONUT"
  }'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO courses (slug, title, price, image_url, active, sort_order, raw_data)
VALUES (
  'banh-mi',
  'Khóa Học Bánh Mì Việt Nam Chuẩn Vị',
  '299.000đ',
  'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&q=80&w=800',
  true,
  2,
  '{
    "bankName": "Techcombank",
    "bankAccount": "1903456789012",
    "bankOwner": "NGUYEN VAN A",
    "transferNote": "BANHMI GMAIL_CUA_BAN",
    "qrImageUrl": "https://img.vietqr.io/image/TCB-1903456789012-compact.png?amount=299000&addInfo=BANHMI"
  }'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- ==============================================================================
-- HỆ THỐNG LMS / HỌC VIÊN & BÀI HỌC (BỔ SUNG)
-- ==============================================================================

-- 5. Bảng lessons (Thay thế tab Lessons)
CREATE TABLE IF NOT EXISTS lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  course_slug TEXT NOT NULL,
  lesson_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  video_provider TEXT DEFAULT 'bunny',
  video_url TEXT,
  bunny_library_id TEXT,
  bunny_video_id TEXT,
  recipe_url TEXT,
  document_url TEXT,
  photo_url TEXT,
  thumbnail_url TEXT,
  duration_text TEXT,
  level TEXT,
  media_urls TEXT,
  views INTEGER DEFAULT 0,
  is_free BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  status TEXT DEFAULT 'active',
  sort_order INTEGER DEFAULT 0,
  raw_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (course_slug, lesson_no)
);

-- 6. Bảng students (Thay thế tab Students)
CREATE TABLE IF NOT EXISTS students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  phone TEXT,
  status TEXT DEFAULT 'active',
  note TEXT,
  raw_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 7. Bảng student_enrollments (Quản lý phân quyền học viên vào khóa học)
CREATE TABLE IF NOT EXISTS student_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  course_slug TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  source_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (email, course_slug)
);

-- 8. Bảng site_config (Thay thế tab Config)
CREATE TABLE IF NOT EXISTS site_config (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 9. Bảng lesson_progress (Theo dõi tiến độ học)
CREATE TABLE IF NOT EXISTS lesson_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  course_slug TEXT NOT NULL,
  lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE,
  progress_percent INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT false,
  last_watched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (email, lesson_id)
);

-- 10. Tạo indexes cho các bảng LMS mới
CREATE INDEX IF NOT EXISTS idx_lessons_course_slug ON lessons(course_slug);
CREATE INDEX IF NOT EXISTS idx_lessons_sort ON lessons(course_slug, sort_order, lesson_no);
CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);
CREATE INDEX IF NOT EXISTS idx_student_enrollments_email ON student_enrollments(email);
CREATE INDEX IF NOT EXISTS idx_student_enrollments_course_slug ON student_enrollments(course_slug);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_email ON lesson_progress(email);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_lookup ON lesson_progress(email, lesson_id);

