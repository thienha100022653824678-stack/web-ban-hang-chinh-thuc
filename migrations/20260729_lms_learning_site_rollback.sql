BEGIN;
DROP INDEX IF EXISTS public.idx_courses_learning_target_site;
DROP INDEX IF EXISTS public.idx_courses_learning_site_active_status;
DROP INDEX IF EXISTS public.idx_courses_learning_site;
ALTER TABLE public.courses DROP CONSTRAINT IF EXISTS courses_learning_site_check;
ALTER TABLE public.courses DROP COLUMN IF EXISTS learning_site;
COMMIT;

