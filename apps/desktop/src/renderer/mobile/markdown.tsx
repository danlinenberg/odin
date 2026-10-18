import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * A message as Claude wrote it: bold, lists, code, tables. The desktop's
 * MarkdownRenderer brings its stores and context menu along, so the phone uses
 * the same parser with its own styles (.md in mobile.css).
 */
export function Markdown({ text }: { text: string }) {
	return (
		<div className="md select-text break-words">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) => (
						<a href={href} target="_blank" rel="noreferrer">
							{children}
						</a>
					),
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}
