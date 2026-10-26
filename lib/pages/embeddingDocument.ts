import {
  EMBEDDING_DOCUMENT_MAX_CHARS,
  hashEmbeddingDocument,
} from '@/lib/workItems/embeddingDocument';

// WHAT a page's meaning vector is derived from (Story MOTIR-9490 · MOTIR-9571).
// PURE — no db, no client, no `server-only` — so the three consumers that must
// agree cannot drift: the job that embeds a page after a save, the hash it
// compares to skip an unchanged one, and the backfill that finds the pages still
// missing a vector. It is the page twin of `lib/workItems/embeddingDocument.ts`,
// and reuses its cap and its hash so pages and work items are cut and hashed the
// same way.
//
// The body is `body_text` — the plain text every markdown door derives on each
// save, and the SAME text the full-text expression (`PAGE_SEARCH_DOCUMENT`)
// reads — so by-word and by-meaning search see one page, not two.

export { hashEmbeddingDocument };

/** The two fields a page's document is composed from. */
export interface PageEmbeddingDocumentSource {
  title: string;
  bodyText: string | null;
}

/**
 * The embedded document: `title` + "\n\n" + `bodyText`, cut to
 * `EMBEDDING_DOCUMENT_MAX_CHARS`. The separator is emitted even for an empty
 * body, so the document is a pure function of the pair.
 */
export function composePageEmbeddingDocument(source: PageEmbeddingDocumentSource): string {
  const document = `${source.title}\n\n${source.bodyText ?? ''}`;
  return document.slice(0, EMBEDDING_DOCUMENT_MAX_CHARS);
}
