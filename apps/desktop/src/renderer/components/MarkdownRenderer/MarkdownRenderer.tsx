import { cn } from "@odin/ui/utils";
import { useRef } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useMarkdownStyle } from "renderer/stores";
import { SelectionContextMenu } from "./components";
import { defaultConfig } from "./styles/default/config";
import { tufteConfig } from "./styles/tufte/config";

/** Images saved to ~/.odin/attachments (SafeImage allows the scheme too). */
const ATTACHMENT_SCHEME = "odin-attachment";

/** An image path an agent wrote, e.g. a screenshot it saved: main serves it under the scheme. */
const LOCAL_IMAGE = /^(?:file:\/\/)?(\/[^?#]+\.(?:png|jpe?g|gif|webp))$/i;

const safeDecode = (value: string) => {
	try {
		return decodeURI(value);
	} catch {
		return value;
	}
};

/** react-markdown and rehype-sanitize both drop unknown schemes; keep ours. */
export const keepAttachmentUrls = (url: string, key?: string) => {
	if (url.startsWith(`${ATTACHMENT_SCHEME}://`)) return url;
	const localPath = key === "src" && url.match(LOCAL_IMAGE)?.[1];
	if (localPath)
		return `${ATTACHMENT_SCHEME}://local${encodeURI(safeDecode(localPath))}`;
	return defaultUrlTransform(url);
};

export const sanitizeSchema = {
	...defaultSchema,
	protocols: {
		...defaultSchema.protocols,
		src: [...(defaultSchema.protocols?.src ?? []), ATTACHMENT_SCHEME],
	},
};

/** Text blocks that read right-to-left when their first letter is Hebrew. */
const TEXT_BLOCKS = new Set([
	"p",
	"li",
	"ul",
	"ol",
	"blockquote",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"th",
	"td",
]);

type HastNode = {
	type: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
};

/** dir="auto" on each text block, so a Hebrew reply reads right-to-left, paragraph by paragraph. */
export const rehypeAutoDir = () => (tree: HastNode) => {
	const walk = (node: HastNode) => {
		if (node.type === "element" && TEXT_BLOCKS.has(node.tagName ?? ""))
			node.properties = { ...node.properties, dir: "auto" };
		node.children?.forEach(walk);
	};
	walk(tree);
};

const styleConfigs = {
	default: defaultConfig,
	tufte: tufteConfig,
} as const;

interface MarkdownRendererProps {
	content: string;
	style?: keyof typeof styleConfigs;
	className?: string;
	/** Parse raw inline HTML. Disable for remote/untrusted content (e.g. server-driven notices). */
	allowHtml?: boolean;
}

export function MarkdownRenderer({
	content,
	style: styleProp,
	className,
	allowHtml = true,
}: MarkdownRendererProps) {
	const globalStyle = useMarkdownStyle();
	const style = styleProp ?? globalStyle;
	const config = styleConfigs[style];
	const articleRef = useRef<HTMLElement | null>(null);

	return (
		<SelectionContextMenu selectAllContainerRef={articleRef}>
			<div
				className={cn(
					"markdown-renderer h-full overflow-y-auto select-text",
					config.wrapperClass,
					className,
				)}
			>
				<article ref={articleRef} className={config.articleClass}>
					<ReactMarkdown
						remarkPlugins={[remarkGfm]}
						rehypePlugins={
							allowHtml
								? [rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeAutoDir]
								: [[rehypeSanitize, sanitizeSchema], rehypeAutoDir]
						}
						urlTransform={keepAttachmentUrls}
						components={config.components}
					>
						{content}
					</ReactMarkdown>
				</article>
			</div>
		</SelectionContextMenu>
	);
}
