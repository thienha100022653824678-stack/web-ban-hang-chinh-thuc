BEGIN;

DROP INDEX IF EXISTS public.idx_orders_learning_target_tenant;
DROP INDEX IF EXISTS public.idx_orders_lms_tenant_status;
DROP INDEX IF EXISTS public.idx_courses_learning_target_tenant;
DROP INDEX IF EXISTS public.idx_courses_lms_tenant_active_status;
DROP INDEX IF EXISTS public.idx_courses_lms_tenant;

ALTER TABLE public.courses
  DROP CONSTRAINT IF EXISTS courses_lms_tenant_check;

ALTER TABLE public.courses
  DROP COLUMN IF EXISTS lms_tenant;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_lms_tenant_check;

ALTER TABLE public.orders
  DROP COLUMN IF EXISTS lms_tenant;

COMMIT;

