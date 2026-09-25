-- Private bucket for board thumbnails. Accessed only by apps/server with the service key;
-- browsers get short-lived signed URLs. storage.objects has RLS on and we add no policies,
-- so the public Storage API can never read these files directly.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('board-thumbnails', 'board-thumbnails', false, 307200, ARRAY['image/png'])
ON CONFLICT (id) DO NOTHING;
