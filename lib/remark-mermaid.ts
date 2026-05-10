import type { Code, Root } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

/**
 * Replace ```mermaid code fences with a JSX `<Mermaid chart="..." />` element
 * so the client component can render the diagram instead of Shiki tokenising
 * the source as if it were a programming language.
 */
export const remarkMermaid: Plugin<[], Root> = () => (tree) => {
  visit(tree, "code", (node: Code, index, parent) => {
    if (node.lang !== "mermaid") return;
    if (parent == null || typeof index !== "number") return;
    parent.children[index] = {
      type: "mdxJsxFlowElement",
      name: "Mermaid",
      attributes: [
        {
          type: "mdxJsxAttribute",
          name: "chart",
          value: node.value,
        },
      ],
      children: [],
      // biome-ignore lint/suspicious/noExplicitAny: mdast-util-mdx node typing
    } as any;
  });
};
