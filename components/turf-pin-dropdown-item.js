import { useMutation, useApolloClient } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { Dropdown } from 'react-bootstrap'
import { useToast } from './toast'

const SET_TURF_PIN = gql`
  mutation SetTurfPin($id: ID!, $subName: String!, $pinned: Boolean!) {
    setTurfPin(id: $id, subName: $subName, pinned: $pinned) {
      id
      turfPins {
        subName
        position
      }
    }
  }`

// One explicit desired-state action for one post–turf membership. The label
// names the turf and the target state, so a retried click can never flip a
// pin back; there is no modal and no route inference.
export default function TurfPinDropdownItem ({ item, turf }) {
  const toaster = useToast()
  const client = useApolloClient()
  // no awaitRefetchQueries here: a failed refetch would reject the mutation
  // promise and mask a pin the server already committed. The mutation result
  // writes the item's turfPins through the cache; feeds are refetched below
  // so sibling positions (compaction) stay current.
  const [setTurfPin, { loading }] = useMutation(SET_TURF_PIN)

  return (
    <Dropdown.Item
      disabled={loading}
      onClick={async () => {
        try {
          await setTurfPin({ variables: { id: item.id, subName: turf.name, pinned: !turf.pinned } })
          toaster.success(turf.pinned ? `unpinned from ~${turf.name}` : `pinned to ~${turf.name}`)
          try {
            await client.refetchQueries({ include: ['SubItems', 'Item'] })
          } catch {
            toaster.danger(`saved, but refresh failed — reload to see ~${turf.name} updated`)
          }
        } catch (err) {
          toaster.danger(err.message)
        }
      }}
    >
      {turf.pinned ? `unpin from ~${turf.name}` : `pin to ~${turf.name}`}
    </Dropdown.Item>
  )
}
