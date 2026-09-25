-- Private bucket for board thumbnails. Accessed only by apps/server with the service key;
-- browsers get short-lived signed URLs. storage.objects has RLS on and we add no policies,
-- so the public Storage API can never read these files directly.
-- The `storage` schema belongs to Supabase's Storage service: it exists in every hosted project
-- but not in the bare supabase/postgres image CI tests run against, where this is a no-op.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('board-thumbnails', 'board-thumbnails', false, 307200, ARRAY['image/png'])
    ON CONFLICT (id) DO NOTHING;
  END IF;
END
$$;
