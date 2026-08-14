// bare /referrals has no chart to show — send it to the default when-bucket.
// the documented redirect return (not res.writeHead) so Next's client-side
// router follows it on data-route navigation too, not just full page loads
export default function ReferralsIndex () {
  return null
}

export async function getServerSideProps () {
  return {
    redirect: {
      destination: '/referrals/day',
      permanent: false
    }
  }
}
