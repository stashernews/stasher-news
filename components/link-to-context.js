import classNames from 'classnames'
import styles from './link-to-context.module.css'
import Link from 'next/link'

export default function LinkToContext ({ children, onClick, href, className, pad, ...props }) {
  return (
    <div className={classNames(className, styles.linkBoxParent, { [styles.pad]: pad })}>
      {/* this anchor has no text content by design — it's a full-row click
          overlay. without a name, screen readers announce it as "unlabeled".
          consumers may override via props (spread below). */}
      <Link
        className={styles.linkBox}
        onClick={onClick}
        href={href}
        aria-label='view in context'
        {...props}
      />
      {children}
    </div>
  )
}
