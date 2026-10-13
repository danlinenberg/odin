import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { keepAttachmentUrls, sanitizeSchema } from "./MarkdownRenderer";

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
