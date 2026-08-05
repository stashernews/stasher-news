import { useEffect, useState } from 'react'
import AccordianItem from './accordian-item'
import { useRouter } from 'next/router'
import { useFormikContext } from 'formik'

const FormStatus = {
  DIRTY: 'dirty'
}

export default function AdvPostForm ({ children }) {
  const router = useRouter()
  const formik = useFormikContext()
  const [show, setShow] = useState(false)

  useEffect(() => {
    // if the adv post form is dirty on first render, show the accordian
    if (router.query?.type === 'link' && formik?.values.text !== '') {
      setShow(FormStatus.DIRTY)
    }
  }, [formik?.values, router.query?.type])

  return (
    <AccordianItem
      header={<div style={{ fontWeight: 'bold', fontSize: '92%' }}>options</div>}
      show={show}
      body={<>{children}</>}
    />
  )
}
