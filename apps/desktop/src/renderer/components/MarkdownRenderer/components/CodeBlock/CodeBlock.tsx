import { ShowCode } from "@odin/ui/ai-elements/show-code";
import { Button } from "@odin/ui/button";
import { mermaid } from "@streamdown/mermaid";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTheme } from "renderer/stores";
import { Streamdown } from "streamdown";

const mermaidPlugins = { mermaid };

// A `text` fence is almost always a draft message to paste somewhere
// (Slack, email, a PR), so it reads as wrapped prose, not numbered code.
const PROSE_LANGUAGES = new Set(["text", "txt", "plaintext"]);

// ponytail: an unlabelled fence counts as prose when some line is a long
// sentence; a smarter classifier only if commands start landing here.
export function looksLikeProse(code: string): boolean {
	return code
		.split("\n")
		.some(
			(line) =>
				line.trim().split(/\s+/).length >= 12 && /[.?!]$/.test(line.trim()),
		);
}

function PasteBlock({ text }: { text: string }) {
	const [isCopied, setIsCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 2000);
		} catch {
			// clipboard unavailable
		}
	};
	return (
		<div className="group relative my-4 rounded-md border border-border border-l-2 border-l-primary/60 bg-muted/30 py-3 pl-4 pr-20">
			<Button
				className="absolute right-2 top-2 h-7 gap-1.5 px-2 text-xs"
				onClick={copy}
				size="sm"
				variant="ghost"
			>
				{isCopied ? (
					<CheckIcon className="size-3.5" />
				) : (
					<CopyIcon className="size-3.5" />
				)}
				{isCopied ? "Copied" : "Copy"}
			</Button>
			<div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
				{text}
			</div>
		</div>
	);
}

interface CodeNode {
	position?: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
}

interface CodeBlockProps {
	children?: ReactNode;
	className?: string;
	node?: CodeNode;
}

export function CodeBlock({ children, className, node }: CodeBlockProps) {
	const theme = useTheme();
	const isDark = theme?.type !== "light";

	const match = /language-(\w+)/.exec(className || "");
	const language = match ? match[1] : undefined;
	const codeString = String(children).replace(/\n$/, "");

	const isInline =
		!language && node?.position?.start.line === node?.position?.end.line;

	if (isInline) {
		return (
			<code className="px-1.5 py-0.5 rounded bg-muted font-mono text-sm">
				{children}
			</code>
		);
	}

	if (language === "mermaid") {
		return (
			<Streamdown
				mode="static"
				plugins={mermaidPlugins}
				mermaid={{ config: { theme: isDark ? "dark" : "default" } }}
			>
				{`\`\`\`mermaid\n${codeString}\n\`\`\``}
			</Streamdown>
		);
	}

	if (language ? PROSE_LANGUAGES.has(language) : looksLikeProse(codeString)) {
		return <PasteBlock text={codeString} />;
	}

	return (
		<ShowCode
			className="my-4"
			// biome-ignore lint/suspicious/noExplicitAny: ShowCode accepts BundledLanguage; language is an untyped string here
			language={language as any}
			code={codeString}
			showLineNumbers
		/>
	);
}
