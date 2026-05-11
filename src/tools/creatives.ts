import { readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphFetch } from "@/services/meta-graph-api";
import { normalizeActId } from "@/utils/account-id";
import { MetaApiError } from "@/utils/errors";
import { writeTool } from "@/utils/register-tool";
import { fail, ok } from "@/utils/tool-response";

/**
 * Creative tools — image upload + creative assembly.
 *
 * Per docs/SPEC.md decision #7, v0.1 was "local file paths only". v0.2 also
 * accepts URLs since (a) it's a one-line addition (Meta's `url=...` upload
 * mode), (b) tests use it (no binary fixtures in the repo), and (c) it makes
 * the hosted-MCP migration painless if we ever pursue it.
 *
 * Video upload (resumable upload API + transcoding poll) lands in a v0.2
 * follow-up; image is enough to enable end-to-end ad creation today.
 */

interface ImageUploadResponse {
  images: Record<string, { hash: string; url: string }>;
}

interface CreativeCreateResponse {
  id: string;
}

export function registerCreativeTools(server: McpServer): void {
  writeTool(
    server,
    "upload_image",
    `⚠️ WRITE OPERATION — Upload an image to an ad account's image library.

Accepts either a local file path or a public HTTPS URL.
- Local path: server reads the file, base64-encodes the bytes, posts to /act_X/adimages.
- URL: server forwards the URL to Meta which fetches and hashes it.

Returns the resulting image_hash, which you reference in creatives via
\`object_story_spec.link_data.image_hash\`. Hashes are stable per account.

Limits: 8 MB, JPG / PNG / GIF. Animated GIFs are supported only in some placements.`,
    {
      account_id: z.string().describe("Ad account ID, with or without 'act_' prefix."),
      image_path: z
        .string()
        .optional()
        .describe(
          "Absolute path to a local image file. Mutually exclusive with image_url.",
        ),
      image_url: z
        .string()
        .url()
        .refine((u) => u.startsWith("https://"), {
          message:
            "image_url must use https:// — Meta refuses to fetch http or localhost URLs.",
        })
        .optional()
        .describe(
          "Public HTTPS URL Meta will fetch. Must use https:// — http and localhost are rejected. Mutually exclusive with image_path.",
        ),
    },
    async (args) => {
      try {
        if (!args.image_path && !args.image_url) {
          return fail(
            new MetaApiError({
              message: "Must provide either image_path or image_url.",
            }),
          );
        }
        if (args.image_path && args.image_url) {
          return fail(
            new MetaApiError({
              message: "Provide exactly one of image_path / image_url, not both.",
            }),
          );
        }
        const actId = normalizeActId(args.account_id);
        const body: Record<string, unknown> = {};
        if (args.image_url) {
          body.url = args.image_url;
        } else if (args.image_path) {
          const bytes = await readFile(args.image_path);
          body.bytes = bytes.toString("base64");
          // Meta uses the filename as the key in the response — keep it stable
          // by using the basename instead of letting it default to something.
          body.filename = path.basename(args.image_path);
        }
        const res = await graphFetch<ImageUploadResponse>(`${actId}/adimages`, {
          method: "POST",
          body,
        });
        const images = Object.values(res.images ?? {});
        if (images.length === 0) {
          return fail(
            new MetaApiError({
              message: "Meta returned no images in response.",
              raw: res,
            }),
          );
        }
        // For single-file uploads there's one entry; surface its hash + url.
        return ok({
          image_hash: images[0].hash,
          url: images[0].url,
          all: res.images,
        });
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          return fail(
            new MetaApiError({
              message: `Image file not found: ${args.image_path}`,
            }),
          );
        }
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "create_creative",
    `⚠️ WRITE OPERATION — Create an ad creative.

An ad creative is the visual + copy that an ad references. The minimum viable shape
for a link-ad creative:

  create_creative({
    account_id: 'act_123',
    name: 'My creative',
    page_id: '<facebook page ID — required for most creative types>',
    object_story_spec: {
      page_id: '<same page ID>',
      link_data: {
        image_hash: '<from upload_image>',
        message: 'Headline copy',
        link: 'https://example.com',
        name: 'Link title',
        call_to_action: { type: 'LEARN_MORE', value: { link: 'https://example.com' } },
      },
    },
  });

For an image-only creative (no link), use 'photo_data' instead of 'link_data'.
For video, 'video_data' (requires video_id from upload_video).

The 'object_story_spec' field is the most common shape. For Advantage+ Creative,
use 'asset_feed_spec' instead.`,
    {
      account_id: z.string(),
      name: z.string().min(1).optional(),
      object_story_spec: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Standard creative spec — see Meta's adcreative reference. Mutually exclusive with asset_feed_spec.",
        ),
      asset_feed_spec: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Advantage+ Creative feed spec. Mutually exclusive with object_story_spec.",
        ),
      degrees_of_freedom_spec: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Advantage+ Creative DOF spec — controls which optimizations Meta is allowed to apply.",
        ),
      url_tags: z
        .string()
        .optional()
        .describe("URL parameters appended to all outbound links."),
      extra: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Escape hatch for fields not exposed above."),
    },
    async (args) => {
      try {
        if (!args.object_story_spec && !args.asset_feed_spec) {
          return fail(
            new MetaApiError({
              message:
                "Provide object_story_spec (standard creative) or asset_feed_spec (Advantage+ Creative). To attach an existing creative to a new ad, pass `creative: { creative_id }` to create_ad instead — create_creative always builds a new creative.",
            }),
          );
        }
        if (args.object_story_spec && args.asset_feed_spec) {
          return fail(
            new MetaApiError({
              message:
                "object_story_spec and asset_feed_spec are mutually exclusive. Pick one: object_story_spec for a standard creative, asset_feed_spec for Advantage+ Creative.",
            }),
          );
        }
        const actId = normalizeActId(args.account_id);
        const body: Record<string, unknown> = {
          ...(args.name && { name: args.name }),
          ...(args.object_story_spec && { object_story_spec: args.object_story_spec }),
          ...(args.asset_feed_spec && { asset_feed_spec: args.asset_feed_spec }),
          ...(args.degrees_of_freedom_spec && {
            degrees_of_freedom_spec: args.degrees_of_freedom_spec,
          }),
          ...(args.url_tags && { url_tags: args.url_tags }),
          ...(args.extra ?? {}),
        };
        const res = await graphFetch<CreativeCreateResponse>(`${actId}/adcreatives`, {
          method: "POST",
          body,
        });
        return ok({ id: res.id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  writeTool(
    server,
    "delete_creative",
    "⚠️ WRITE OPERATION — Delete an ad creative. Note: creatives in use by ads cannot be deleted; archive the parent ads first.",
    { creative_id: z.string() },
    async ({ creative_id }) => {
      try {
        const res = await graphFetch<{ success?: boolean }>(creative_id, {
          method: "DELETE",
        });
        return ok({ creative_id, deleted: res.success ?? true });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
