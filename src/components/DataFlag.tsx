/** Caveat marker for data-quality flags on a metric (e.g. an approximated
 *  value) -- same hover/focus tooltip mechanics as InfoTip, but styled in
 *  the accent color to read as "mind this" rather than "here's a definition".
 *  Meant to be reused as more flags of this kind show up (see fcf_approximated). */
export function DataFlag({ text }: { text: string }) {
  return (
    <span className="info-tip info-tip-flag" tabIndex={0} aria-label={text}>
      <span aria-hidden="true">!</span>
      <span className="info-tip-bubble" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}
