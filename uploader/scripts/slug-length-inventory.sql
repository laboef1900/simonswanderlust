-- Read-only #353 rollout gate. Run with a read-only transaction/connection.
-- Include drafts and retained snapshots, not just currently published rows.
WITH slugs AS (
  SELECT translation_key, locale, status, 'working' AS source, slug
  FROM posts
  UNION ALL
  SELECT translation_key, published_snapshot->>'locale' AS locale, status,
         'published_snapshot' AS source, published_snapshot->>'slug' AS slug
  FROM posts
  WHERE published_snapshot IS NOT NULL
)
SELECT translation_key, locale, status, source, slug,
       octet_length(slug) AS slug_bytes,
       CASE WHEN slug = '' THEN NULL
            ELSE 'https://simonswanderlust.com/' ||
                 CASE WHEN locale = 'en' THEN 'en/' ELSE '' END || slug || '/'
       END AS url,
       CASE WHEN octet_length(slug) > 251 THEN 'blocked'
            ELSE 'within_bound' END AS rollout
FROM slugs
ORDER BY translation_key, locale, source;
