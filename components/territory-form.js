import AccordianItem from './accordian-item'
import { Col, InputGroup, Row, Form as BootstrapForm, Badge } from 'react-bootstrap'
import { Checkbox, CheckboxGroup, Form, Input, SNInput, Range } from './form'
import FeeButton, { FeeButtonProvider } from './fee-button'
import { gql } from '@apollo/client'
import { useApolloClient, useLazyQuery } from '@apollo/client/react'
import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/router'
import { MAX_TERRITORY_DESC_LENGTH, POST_TYPES, DOMAIN_BETA_IDS } from '@/lib/constants'
import { territorySchema, filterXmrValidator } from '@/lib/validate'
import { useMe } from './me'
import Info from './info'
import { piconerosToXmrDecimal, piconerosToXmr, signedXmrToPiconeros, snapToFilterGrid } from '@/lib/format'
import { SUB } from '@/fragments/subs'
import TerritoryBranding, { useBranding } from './territory-branding'
import Link from 'next/link'
import usePayInMutation from '@/components/payIn/hooks/use-pay-in-mutation'
import { UNARCHIVE_TERRITORY, UPSERT_SUB } from '@/fragments/payIn'
import LinkExternal from '@/svgs/link-external.svg'
import { isAbortError } from '@/lib/error'
import { useShowModal } from './modal'
import TerritoryPendingFeeModal from './territory-pending-fee-modal'

function SatFilterRanges () {
  return (
    <Range
      label={
        <div className='d-flex align-items-center'>posts xmr filter
          <Info>
            <ul>
              <li>minimum net investment (cost + tips + boost - downvotes) for posts to appear in lit/top</li>
            </ul>
          </Info>
        </div>
      }
      name='postsPiconerosFilter'
      min={-0.01}
      max={0.01}
      step={0.0001}
      suffix=' XMR'
    />
  )
}

export default function TerritoryForm ({ sub }) {
  const router = useRouter()
  const client = useApolloClient()
  const { me } = useMe()
  const branding = useBranding()
  const showModal = useShowModal()
  const [upsertSub] = usePayInMutation(UPSERT_SUB)
  const [unarchiveTerritory] = usePayInMutation(UNARCHIVE_TERRITORY)

  const schema = territorySchema({ client, me, sub })
  const xmrSchema = schema.shape({ postsPiconerosFilter: filterXmrValidator })

  const [fetchSub] = useLazyQuery(SUB)
  const [archived, setArchived] = useState(false)
  const onNameChange = useCallback(async (formik, e) => {
    // never show "territory archived" warning during edits
    if (sub) return
    const name = e.target.value
    try {
      const { data } = await fetchSub({ variables: { sub: name } })
      setArchived(data?.sub?.status === 'STOPPED')
    } catch (err) {
      !isAbortError(err) && console.error(err)
    }
  }, [fetchSub, setArchived])

  const onSubmit = useCallback(
    async ({ ...variables }) => {
      variables.postsPiconerosFilter = variables.postsPiconerosFilter == null
        ? null
        : Number(signedXmrToPiconeros(variables.postsPiconerosFilter))
      const { data, error, payError } = archived
        ? await unarchiveTerritory({ variables })
        : await upsertSub({ variables: { oldName: sub?.name, ...variables } })

      if (error) throw error
      if (payError) return

      // modify graphql cache to include new sub
      client.cache.modify({
        fields: {
          subs (existing = [], { readField }) {
            const newSubRef = client.cache.writeFragment({
              data: { __typename: 'Sub', name: variables.name },
              fragment: gql`
                fragment SubSubmitFragment on Sub {
                  name
                }`
            })
            if (existing.some(ref => readField('name', ref) === variables.name)) {
              return existing
            }
            return [...existing, newSubRef]
          }
        }
      })

      // territory created PENDING_FEE — surface the fee payment before navigating.
      // persistOnNavigate keeps the modal open across the redirect below so the
      // founder can actually pay (navigating would otherwise close it immediately).
      const response = data?.upsertSub ?? data?.unarchiveTerritory
      if (response?.moneroUri) {
        showModal(onClose => (
          <TerritoryPendingFeeModal moneroUri={response.moneroUri} subName={variables.name} onClose={onClose} />
        ), { persistOnNavigate: true })
      }
      await router.push(`/~${variables.name}`)
    }, [client, upsertSub, unarchiveTerritory, router, archived, showModal]
  )

  const [billing, setBilling] = useState((sub?.billingType || 'MONTHLY').toLowerCase())
  const monthlyFee = BigInt(me?.privates?.territoryMonthlyPiconeros || 0)
  const yearlyFee = BigInt(me?.privates?.territoryYearlyPiconeros || 0)
  const onceFee = BigInt(me?.privates?.territoryOncePiconeros || 0)

  // Receipt line items quote the LIVE PlatformFeeConfig amounts so the button
  // total always matches the QR invoice the payIn engine builds.
  const lineItems = useMemo(() => {
    const newType = billing.toUpperCase()
    const isUpgrade = sub && sub.billingType !== newType && (newType === 'YEARLY' || newType === 'ONCE')
    if (sub && !isUpgrade) return {}
    const fee = { monthly: monthlyFee, yearly: yearlyFee, once: onceFee }[billing]
    if (fee <= 0n) return {}
    return {
      territory: {
        term: `+ ${piconerosToXmr(fee)}`,
        label: `${billing} turf fee`,
        op: '+',
        modifier: cost => cost + Number(fee / 1000n)
      }
    }
  }, [sub, billing, monthlyFee, yearlyFee, onceFee])

  return (
    <FeeButtonProvider baseLineItems={lineItems}>
      <Form
        initial={{
          name: sub?.name || '',
          desc: sub?.desc || '',
          // Default xmr filter (-0.002 XMR = show downvoted content by default)
          postsPiconerosFilter: sub?.postsPiconerosFilter == null ? -0.002 : snapToFilterGrid(Number(piconerosToXmrDecimal(BigInt(sub.postsPiconerosFilter)))),
          postTypes: sub?.postTypes || POST_TYPES,
          billingType: sub?.billingType || 'MONTHLY',
          billingAutoRenew: sub?.billingAutoRenew || false,
          nsfw: sub?.nsfw || false
        }}
        schema={xmrSchema}
        onSubmit={onSubmit}
        className='mb-5'
        storageKeyPrefix={sub ? undefined : 'territory'}
      >
        <Input
          label='name'
          name='name'
          required
          autoFocus
          clear
          maxLength={32}
          prepend={<InputGroup.Text className='text-monospace'>~</InputGroup.Text>}
          onChange={onNameChange}
          warn={archived && (
            <div className='d-flex align-items-center'>this turf is archived
              <Info>
                <ul>
                  <li>This turf got archived because the previous founder did not pay for the upkeep</li>
                  <li>You can proceed but will inherit the old content</li>
                </ul>
              </Info>
            </div>
          )}
        />
        <SNInput
          label='description'
          name='desc'
          lengthOptions={{ maxLength: MAX_TERRITORY_DESC_LENGTH, show: true }}
          required
          minRows={3}
          topLevel
        />
        <CheckboxGroup label='post types' name='postTypes'>
          <Row>
            <Col xs={4} sm='auto'>
              <Checkbox
                inline
                label='links'
                value='LINK'
                name='postTypes'
                id='links-checkbox'
                groupClassName='ms-1 mb-0'
              />
            </Col>
            <Col xs={4} sm='auto'>
              <Checkbox
                inline
                label='discussions'
                value='DISCUSSION'
                name='postTypes'
                id='discussions-checkbox'
                groupClassName='ms-1 mb-0'
              />
            </Col>
            <Col xs={4} sm='auto'>
              <Checkbox
                inline
                label='polls'
                value='POLL'
                name='postTypes'
                id='polls-checkbox'
                groupClassName='ms-1 mb-0'
              />
            </Col>
          </Row>
        </CheckboxGroup>
        {sub?.billingType !== 'ONCE' &&
          <>
            <CheckboxGroup
              label={
                <span className='d-flex align-items-center'>billing
                </span>
              }
              name='billing'
              groupClassName={billing !== 'once' ? 'mb-0' : ''}
            >
              <Checkbox
                type='radio'
                label={`${piconerosToXmr(monthlyFee)}/month`}
                value='MONTHLY'
                name='billingType'
                id='monthly-checkbox'
                handleChange={checked => checked && setBilling('monthly')}
                groupClassName='ms-1 mb-0'
              />
              <Checkbox
                type='radio'
                label={`${piconerosToXmr(yearlyFee)}/year`}
                value='YEARLY'
                name='billingType'
                id='yearly-checkbox'
                handleChange={checked => checked && setBilling('yearly')}
                groupClassName='ms-1 mb-0'
              />
              <Checkbox
                type='radio'
                label={`${piconerosToXmr(onceFee)} once`}
                value='ONCE'
                name='billingType'
                id='once-checkbox'
                handleChange={checked => checked && setBilling('once')}
                groupClassName='ms-1 mb-0'
              />
            </CheckboxGroup>
            {billing !== 'once' &&
              <Checkbox
                label='remind me to renew'
                name='billingAutoRenew'
                groupClassName='ms-1 mt-2'
              />}
          </>}
        <AccordianItem
          header={<div style={{ fontWeight: 'bold', fontSize: '92%' }}>options</div>}
          body={
            <>
              <SatFilterRanges />
              <BootstrapForm.Label>nsfw</BootstrapForm.Label>
              <Checkbox
                inline
                label={
                  <div className='d-flex align-items-center'>mark as nsfw
                    <Info>
                      <ol>
                        <li>Let stashers know that your turf may contain explicit content</li>
                        <li>Your turf will get a <Badge bg='secondary'>nsfw</Badge> badge</li>
                      </ol>
                    </Info>
                  </div>
          }
                name='nsfw'
                groupClassName='ms-1'
              />
            </>

}
        />
        <div className='mt-3 d-flex justify-content-end'>
          <FeeButton
            text={sub ? 'save' : 'found it'}
            variant='secondary'
            disabled={sub?.status === 'STOPPED'}
          />
        </div>
      </Form>
      {DOMAIN_BETA_IDS.includes(Number(me?.id)) &&
        <>
          {sub && !branding && <TerritoryBranding sub={sub} />}
          {sub && branding && <Link className='text-muted w-100' href={`${process.env.NEXT_PUBLIC_URL}/~${sub.name}/edit`}>domain and branding settings on stasher.news <LinkExternal width={16} height={16} /></Link>}
        </>}
    </FeeButtonProvider>
  )
}
