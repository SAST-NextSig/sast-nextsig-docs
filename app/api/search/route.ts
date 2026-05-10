import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// 不指定 language —— Orama 会用默认 tokenizer 全文索引中文，效果比 'english' 好。
// 如需更精准的中文分词，可改用 createTokenizer from '@orama/tokenizers/mandarin'。
export const { GET } = createFromSource(source);
