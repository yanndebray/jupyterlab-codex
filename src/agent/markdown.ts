/**
 * Minimal Markdown → HTML renderer. Handles fenced code blocks, inline code,
 * bold, italic, headers (# .. ####), bullet lists, and paragraphs.
 *
 * HTML is escaped first to avoid injection from untrusted model output.
 */
export function renderMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const codeBlocks: string[] = [];
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="jp-codex-code"><code>${code}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  html = html.replace(/^#### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

  html = html.replace(/(?:^[-*] .+\n?)+/gm, block => {
    const items = block
      .trim()
      .split('\n')
      .map(l => `<li>${l.replace(/^[-*] /, '')}</li>`)
      .join('');
    return `<ul>${items}</ul>`;
  });

  html = html
    .split(/\n{2,}/)
    .map(block => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (/^<(h\d|ul|pre|\x00CODEBLOCK)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('\n');

  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  return html;
}
