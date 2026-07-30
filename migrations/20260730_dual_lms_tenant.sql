BEGIN;

ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS lms_tenant TEXT;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS lms_tenant TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'courses_lms_tenant_check'
      AND conrelid = 'public.courses'::regclass
  ) THEN
    ALTER TABLE public.courses
      ADD CONSTRAINT courses_lms_tenant_check
      CHECK (lms_tenant IS NULL OR lms_tenant IN ('yeunauan', 'yeubep'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_lms_tenant_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_lms_tenant_check
      CHECK (lms_tenant IS NULL OR lms_tenant IN ('yeunauan', 'yeubep'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_courses_lms_tenant
  ON public.courses (lms_tenant);

CREATE INDEX IF NOT EXISTS idx_courses_lms_tenant_active_status
  ON public.courses (lms_tenant, active, is_published);

CREATE INDEX IF NOT EXISTS idx_courses_learning_target_tenant
  ON public.courses (learning_course_slug, lms_tenant)
  WHERE learning_course_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_lms_tenant_status
  ON public.orders (lms_tenant, status);

CREATE INDEX IF NOT EXISTS idx_orders_learning_target_tenant
  ON public.orders (learning_course_slug, lms_tenant)
  WHERE learning_course_slug IS NOT NULL;

COMMENT ON COLUMN public.courses.lms_tenant IS
  'Logical LMS content owner. Nullable for deterministic legacy compatibility.';

COMMENT ON COLUMN public.orders.lms_tenant IS
  'Immutable logical LMS route snapshot for new dual-LMS orders; legacy rows remain NULL.';

COMMIT;

