// Shared Markdown renderer (tables, lists, headings, etc. via remark-gfm).
// Wide tables get their own scroll container instead of blowing out a
// narrow parent, and links open in a new tab instead of navigating the app.
// Pair with the .markdown-body class (app.css) on the wrapping element for
// the typography rules -- this component only renders the elements.

import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const components = {
  table: (props: ComponentPropsWithoutRef<"table">) => (
    <div className="markdown-table-wrap">
      <table {...props} />
    </div>
  ),
  a: (props: ComponentPropsWithoutRef<"a">) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
