import Link from 'next/link'
import Info from '.'

export default function CCInfo (props) {
  return (
    <Info {...props}>
      <h6>Why am I getting credits?</h6>
      <ul>
        <li>to receive XMR, you must attach an <Link href='/settings/wallet'>external receiving wallet</Link></li>
        <li>bios and free comments can only receive credits</li>
        <li>tippers may have chosen to send you credits instead of XMR</li>
        <li>if the tips are split on a post, we send the recipient with the largest share capable of receiving XMR — others will receive credits</li>
        <li>there could be an issue paying your receiving wallet
          <ul>
            <li>a tip may be delivered as credits when we can't pay your receiving wallet directly, such as when it's below the wallet's minimum</li>
            <li>check your <Link href='/settings/wallet'>wallet logs</Link> for clues</li>
            <li>if you have questions about the errors in your wallet logs, mention the error in the <Link href='/daily'>saloon</Link></li>
          </ul>
        </li>
        <li>some tips might be smaller than your configured receiving dust limit
          <ul>
            <li>you can configure your dust limit in your <Link href='/settings/wallet'>wallet settings</Link></li>
          </ul>
        </li>
      </ul>
    </Info>
  )
}
