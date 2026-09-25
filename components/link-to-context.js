import classNames from 'classnames'
import styles from './link-to-context.module.css'
import Link from 'next/link'

export default function LinkToContext ({ children, onClick, href, className, pad, srLabel = 'view in context', ...props }) {
  return (
    <div className={classNames(className, styles.linkBoxParent, { [styles.pad]: pad })}>
      {/* full-row click overlay for mouse/touch only. Hidden from the a11y tree and
          tab order (paired tabIndex is mandatory with aria-hidden) so screen readers
          can read the row content it covers. */}
      <Link
        {...props}
        className={styles.linkBox}
        onClick={onClick}
        href={href}
        aria-hidden='true'
        tabIndex={-1}
      />
      {children}
      {/* the row's screen-reader/keyboard affordance: visually hidden until
          keyboard-focused (skip-link pattern — focus is never invisible) */}
      <Link
        className={styles.linkBoxSr}
        onClick={onClick}
        href={href}
      >
        {srLabel}
      </Link>
    </div>
  )
}
