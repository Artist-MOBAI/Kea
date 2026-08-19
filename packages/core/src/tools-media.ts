import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { isSensitiveFile } from "./sensitive.ts";
import { resolveGuardTarget } from "./tools.ts";

// read_media_file: hand an image to the model as multimodal content. No client-side crop/downsample (no native
// image-processing dependency) — only safety and size guardrails: sensitive-file refusal, whitelisted formats,
// 10MB cap, relative paths resolved against cwd. When the model has no image input, return an explicit
// placeholder rather than silently dropping the content.

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

export interface ReadMediaFileOptions {
	cwd: string;
	/** whether the current model supports image input (lazy: not stale after setModel) */
	supportsImages: () => boolean;
}

export const READ_MEDIA_FILE_TOOL = "read_media_file";

export function createReadMediaFileTool(options: ReadMediaFileOptions) {
	const parameters = z.strictObject({
		path: z.string().meta({ description: "Path to the image file (png/jpg/jpeg/gif/webp)." }),
	});
	return {
		name: READ_MEDIA_FILE_TOOL,
		label: "Read media file",
		description: [
			"Read an image file and pass it to the model as visual content.",
			"Supported formats: png, jpg/jpeg, gif, webp. Max size 10 MB.",
			"Use this when the task depends on what an image shows (plots, screenshots, diagrams, photos of apparatus).",
			"Describe what you see in your reply with concrete detail; do not assume content you cannot verify.",
		].join(" "),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			const path = isAbsolute(params.path) ? params.path : join(options.cwd, params.path);

			// symlink anti-bypass: photo.png -> ~/.ssh/id_rsa would slip past a string-only check, so
			// realpath-resolve and check the target again; a missing target falls back to the lexical path so
			// the not-found branch still works. Error branches throw (returning isError is dropped by pi).
			const resolved = await resolveGuardTarget(path);
			if (isSensitiveFile(path) || isSensitiveFile(resolved)) {
				throw new Error(`Refused: ${params.path} matches a sensitive-file pattern.`);
			}

			const ext = params.path.slice(params.path.lastIndexOf(".")).toLowerCase();
			const mimeType = MIME_BY_EXT[ext];
			if (!mimeType) {
				throw new Error(
					`Unsupported media type "${ext || "(no extension)"}". Supported: ${Object.keys(MIME_BY_EXT).join(", ")}.`,
				);
			}

			const file = Bun.file(path);
			if (!(await file.exists())) {
				throw new Error(`File not found: ${params.path}`);
			}
			const size = file.size;
			if (size > MAX_IMAGE_BYTES) {
				throw new Error(`Image too large: ${(size / 1024 / 1024).toFixed(1)} MB (cap 10 MB).`);
			}

			if (!options.supportsImages()) {
				return {
					content: [
						{
							type: "text",
							text: `[image omitted: current model has no image input] ${params.path} (${(size / 1024).toFixed(0)} KB ${mimeType})`,
						},
					],
					details: { omitted: true, path: params.path, mimeType, bytes: size },
				};
			}

			const bytes = await file.arrayBuffer();
			const data = new Uint8Array(bytes).toBase64();
			return {
				content: [
					{ type: "image", data, mimeType },
					{ type: "text", text: `Image: ${params.path} (${(size / 1024).toFixed(0)} KB, ${mimeType})` },
				],
				details: { path: params.path, mimeType, bytes: size },
			};
		},
	};
}
