import * as React from "react"

/**
 * Controlled-with-uncontrolled-fallback state. When `controlled` is provided
 * the component is fully controlled; otherwise internal state is used and
 * `onChange` still fires. Internal only — not exported from the package root.
 */
export function useControlledState<T>(
  controlled: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void,
): [T, (value: T) => void] {
  const [internal, setInternal] = React.useState<T>(defaultValue)
  const value = controlled === undefined ? internal : controlled
  const set = React.useCallback(
    (next: T) => {
      if (controlled === undefined) {
        setInternal(next)
      }
      onChange?.(next)
    },
    [controlled, onChange],
  )
  return [value, set]
}
