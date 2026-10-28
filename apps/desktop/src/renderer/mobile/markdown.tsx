import { isValidElement, type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	isRtlText,
	looksLikeProse,
	markRtlLines,
	PROSE_LANGUAGES,
} from "renderer/components/MarkdownRenderer/components/CodeBlock/prose";

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
					pre: ({ children }) => {
						const draft = draftText(children);
						return draft === null ? (
							<pre>{children}</pre>
						) : (
							<Draft text={draft} />
						);
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}

/**
 * The text of a fence that is a draft to paste somewhere, as the desktop's
 * CodeBlock decides it: a `text` fence, or an unlabelled one that reads as prose.
 */
export function draftText(children: ReactNode): string | null {
	if (!isValidElement<{ className?: string; children?: ReactNode }>(children))
		return null;
	const language = /language-(\w+)/.exec(children.props.className ?? "")?.[1];
	const code = String(children.props.children ?? "").replace(/\n$/, "");
	if (language ? PROSE_LANGUAGES.has(language) : looksLikeProse(code))
		return code;
	return null;
}

/**
 * A draft as the desktop shows it: wrapped prose in a card with Copy, not one
 * scrolling line of code. A Hebrew one reads right-to-left.
 */
function Draft({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(markRtlLines(text));
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// clipboard unavailable
		}
	};
	return (
		<div className="draft" dir={isRtlText(text) ? "rtl" : "ltr"}>
			<div className="draft-text">{text}</div>
			<button type="button" className="draft-copy" onClick={copy}>
				{copied ? "Copied" : "Copy"}
			</button>
		</div>
	);
}
