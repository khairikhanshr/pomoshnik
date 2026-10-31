// Markdown -> compact plain text for one-line previews (overlay reply, chat previews). Pure.

export function markdownToPlain(markdown: string): string {
  return (
    markdown
      // fenced code blocks (also an unterminated one while streaming)
      .replace(/```[^\n]*\n[\s\S]*?(```|$)/g, ' [код] ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, '• ')
      .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
      .replace(/^[ \t]*\|?([ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*$/gm, '')
      .replace(/\|/g, ' ')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}
