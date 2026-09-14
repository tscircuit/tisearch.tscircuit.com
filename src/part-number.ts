export const validatePartNumber = (value: unknown): string => {
  const part = typeof value === "string" ? value.trim() : ""
  if (
    !/^[A-Za-z0-9][A-Za-z0-9./+_-]{0,99}$/.test(part) ||
    part.toLowerCase() === "catalog"
  )
    throw new Error("Provide one exact TI orderable part number")
  return part
}
