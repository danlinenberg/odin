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

/** react-markdown and rehype-sanitize both drop unknown schemes; keep ours. */
export const keepAttachmentUrls = (url: string) =>
	url.startsWith(`${ATTACHMENT_SCHEME}://`) ? url : defaultUrlTransform(url);

export const sanitizeSchema = {
	...defaultSchema,
	protocols: {
		...defaultSchema.protocols,
		src: [...(defaultSchema.protocols?.src ?? []), ATTACHMENT_SCHEME],
	},
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
								? [rehypeRaw, [rehypeSanitize, sanitizeSchema]]
								: [[rehypeSanitize, sanitizeSchema]]
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
