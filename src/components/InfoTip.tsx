/** Small "i" glyph that shows an explanatory tooltip on hover/focus.
 *  aria-label carries the text for screen readers; the bubble itself is
 *  decorative (aria-hidden) since it's just a CSS-visibility toggle. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" tabIndex={0} aria-label={text}>
      <span aria-hidden="true">i</span>
      <span className="info-tip-bubble" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}
