/** Small "i" icon that reveals an explanatory tooltip on hover or keyboard focus. */
export function InfoTip({ text }: { text: string }): React.JSX.Element {
  return (
    <span className="info-tip" tabIndex={0} aria-label={text}>
      i
      <span className="info-tip-bubble" role="tooltip">
        {text}
      </span>
    </span>
  )
}
