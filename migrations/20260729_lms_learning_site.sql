BEGIN;

ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS learning_site TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'courses_learning_site_check'
      AND conrelid = 'public.courses'::regclass
  ) THEN
    ALTER TABLE public.courses
      ADD CONSTRAINT courses_learning_site_check
      CHECK (learning_site IS NULL OR learning_site IN ('yeunauan', 'yeubep'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_courses_learning_site
  ON public.courses (learning_site);
CREATE INDEX IF NOT EXISTS idx_courses_learning_site_active_status
  ON public.courses (learning_site, active, is_published);
CREATE INDEX IF NOT EXISTS idx_courses_learning_target_site
  ON public.courses (learning_course_slug, learning_site)
  WHERE learning_course_slug IS NOT NULL;

COMMIT;

