import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { SafeImage } from "./components";
import {
	keepAttachmentUrls,
	rehypeAutoDir,
	sanitizeSchema,
} from "./MarkdownRenderer";

test("keeps an odin-attachment image and still drops javascript: links", () => {
	const html = renderToStaticMarkup(
		<ReactMarkdown
			rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
			urlTransform={keepAttachmentUrls}
		>
			{"![pill](odin-attachment://file/a.png) [x](javascript:alert(1))"}
		</ReactMarkdown>,
	);
	expect(html).toContain('src="odin-attachment://file/a.png"');
	expect(html).not.toContain("javascript:");
});

test("serves an agent's local image path through the attachment scheme", () => {
	const html = renderToStaticMarkup(
		<ReactMarkdown
			rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
			urlTransform={keepAttachmentUrls}
		>
			{
				"![shot](/private/tmp/qa/after%20click.png) ![doc](/etc/passwd) [link](/tmp/a.png)"
			}
		</ReactMarkdown>,
	);
	expect(html).toContain(
		'src="odin-attachment://local/private/tmp/qa/after%20click.png"',
	);
	expect(html).toContain('src="/etc/passwd"');
	expect(html).toContain('href="/tmp/a.png"');
});

test("shows an image as a thumbnail that a click enlarges", () => {
	const html = renderToStaticMarkup(<SafeImage src="https://x.test/a.png" />);
	expect(html).toContain("cursor-zoom-in");
	expect(html).toContain("max-h-40 max-w-60");
});

test("each text block picks its own direction, code stays left-to-right", () => {
	const html = renderToStaticMarkup(
		<ReactMarkdown rehypePlugins={[rehypeAutoDir]}>
			{"שלום עולם\n\n- פריט\n\n```\ncode\n```"}
		</ReactMarkdown>,
	);
	expect(html).toContain('<p dir="auto">שלום עולם</p>');
	expect(html).toContain('<ul dir="auto">');
	expect(html).toContain('<li dir="auto">');
	expect(html).toContain("<pre><code>");
});
