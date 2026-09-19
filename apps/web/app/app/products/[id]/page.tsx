"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Select,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"

type ProductPrice = {
  id: string
  productId: string
  currency: string
  unitAmount: string | number
}

type ProductDetail = {
  id: string
  workspaceId: string
  sku: string
  name: string
  description: string | null
  ownerId: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
  prices: ProductPrice[]
}

const STATUS_OPTIONS = [
  { value: "true", label: "Active" },
  { value: "false", label: "Inactive" },
]

function formatAmount(value: string | number): string {
  const amount = typeof value === "string" ? Number(value) : value
  return Number.isFinite(amount) ? amount.toFixed(2) : String(value)
}

/** Product detail: header, tabbed overview/timeline, inline edit, archive. */
export default function ProductDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [product, setProduct] = useState<ProductDetail | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleted, setDeleted] = useState(false)
  const [name, setName] = useState("")
  const [sku, setSku] = useState("")
  const [isActive, setIsActive] = useState("true")
  const [description, setDescription] = useState("")
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [priceCurrency, setPriceCurrency] = useState("")
  const [priceAmount, setPriceAmount] = useState("")
  const [priceError, setPriceError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<ProductDetail>(`/api/v1/products/${id}`)
      setProduct(data)
      setDeleted(false)
      setName(data.name)
      setSku(data.sku)
      setIsActive(data.isActive ? "true" : "false")
      setDescription(data.description ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this product.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = await apiFetch<ProductDetail>(`/api/v1/products/${id}`, {
        method: "PATCH",
        body: {
          name: name.trim(),
          sku: sku.trim(),
          isActive: isActive === "true",
          description: description.trim() === "" ? null : description.trim(),
        },
      })
      setProduct({ ...updated, prices: product?.prices ?? updated.prices })
      toast({ title: "Product updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const savePrice = async (e: React.FormEvent) => {
    e.preventDefault()
    const currency = priceCurrency.trim().toUpperCase()
    const amount = Number(priceAmount)
    if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(amount) || amount < 0) {
      setPriceError("Enter a 3-letter currency and a non-negative amount.")
      return
    }
    setPriceError(null)
    try {
      const current = (product?.prices ?? []).map((p) => ({
        currency: p.currency,
        unitAmount: typeof p.unitAmount === "string" ? Number(p.unitAmount) : p.unitAmount,
      }))
      const next = [
        ...current.filter((p) => p.currency !== currency),
        { currency, unitAmount: amount },
      ]
      const updated = await apiFetch<ProductDetail>(`/api/v1/products/${id}`, {
        method: "PATCH",
        body: { prices: next },
      })
      setProduct(updated)
      setPriceCurrency("")
      setPriceAmount("")
      toast({ title: "Price saved" })
    } catch (err) {
      setPriceError(err instanceof ApiError ? err.message : "Could not save the price.")
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/products/${id}`, { method: "DELETE" })
      setDeleted(true)
      setConfirmDelete(false)
      toast({ title: "Product archived", description: "It can be restored from this page." })
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const restore = async () => {
    try {
      const updated = await apiFetch<ProductDetail>(`/api/v1/products/${id}/restore`, {
        method: "POST",
      })
      setProduct(updated)
      setDeleted(false)
      toast({ title: "Product restored" })
    } catch (err) {
      toast({
        title: "Restore failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading product">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || product === null) {
    return (
      <ErrorState message={error ?? "This product does not exist."} onRetry={() => void load()} />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/products" className="text-sm text-muted-foreground hover:underline">
        ← Back to products
      </Link>
      <RecordHeader
        title={product.name}
        subtitle={product.sku}
        status={{
          label: deleted ? "Archived" : product.isActive ? "Active" : "Inactive",
          tone: !deleted && product.isActive ? "success" : "secondary",
        }}
        owner={undefined}
        actions={
          deleted ? (
            <Button variant="outline" size="sm" onClick={() => void restore()}>
              Restore
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => router.push("/app/products")}>
                Catalog
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
                Archive
              </Button>
            </>
          )
        }
      />

      {deleted ? (
        <EmptyState
          title="This product is archived"
          description="Restore it to keep selling with stable product and price data."
          action={
            <Button type="button" onClick={() => void restore()}>
              Restore product
            </Button>
          }
        />
      ) : (
        <Tabs
          value={tab}
          onValueChange={setTab}
          ariaLabel="Product sections"
          items={[
            {
              value: "overview",
              label: "Overview",
              content: (
                <div className="grid gap-6 py-4 lg:grid-cols-2">
                  <section aria-label="Price list" className="flex flex-col gap-3">
                    <h2 className="text-sm font-semibold">Prices</h2>
                    {product.prices.length === 0 ? (
                      <EmptyState
                        title="No prices yet"
                        description="Add a currency price so deals and quotes can reference it."
                      />
                    ) : (
                      <dl className="flex flex-col gap-2 text-sm">
                        {product.prices.map((price) => (
                          <div key={price.id} className="flex items-center gap-2">
                            <dt className="w-16 shrink-0 text-muted-foreground">
                              {price.currency}
                            </dt>
                            <dd>{formatAmount(price.unitAmount)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    <form onSubmit={savePrice} className="flex flex-col gap-2">
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Currency" htmlFor="price-currency">
                          <TextField
                            id="price-currency"
                            value={priceCurrency}
                            onChange={(e) => setPriceCurrency(e.currentTarget.value)}
                            placeholder="USD"
                            maxLength={3}
                          />
                        </Field>
                        <Field label="Amount" htmlFor="price-amount">
                          <TextField
                            id="price-amount"
                            value={priceAmount}
                            onChange={(e) => setPriceAmount(e.currentTarget.value)}
                            placeholder="19.99"
                            inputMode="decimal"
                          />
                        </Field>
                      </div>
                      {priceError !== null ? (
                        <p className="text-sm text-destructive">{priceError}</p>
                      ) : null}
                      <div>
                        <Button type="submit" size="sm" variant="outline">
                          Save price
                        </Button>
                      </div>
                    </form>
                    {product.description ? (
                      <div className="flex flex-col gap-1">
                        <h3 className="text-sm font-semibold">Description</h3>
                        <p className="whitespace-pre-wrap text-sm">{product.description}</p>
                      </div>
                    ) : null}
                  </section>
                  <section aria-label="Edit product">
                    <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                    <form onSubmit={save} className="flex flex-col gap-3">
                      <Field label="Name" htmlFor="product-name">
                        <TextField
                          id="product-name"
                          value={name}
                          onChange={(e) => setName(e.currentTarget.value)}
                        />
                      </Field>
                      <Field label="SKU" htmlFor="product-sku">
                        <TextField
                          id="product-sku"
                          value={sku}
                          onChange={(e) => setSku(e.currentTarget.value)}
                        />
                      </Field>
                      <Field label="Status" htmlFor="product-status">
                        <Select
                          id="product-status"
                          value={isActive}
                          onChange={(e) => setIsActive(e.currentTarget.value)}
                          options={STATUS_OPTIONS}
                        />
                      </Field>
                      <Field label="Description" htmlFor="product-description">
                        <TextArea
                          id="product-description"
                          value={description}
                          onChange={(e) => setDescription(e.currentTarget.value)}
                        />
                      </Field>
                      <div>
                        <Button type="submit" disabled={saving}>
                          {saving ? "Saving…" : "Save changes"}
                        </Button>
                      </div>
                    </form>
                  </section>
                </div>
              ),
            },
            {
              value: "activity",
              label: "Activity",
              content: (
                <div className="py-4">
                  <Timeline
                    items={[
                      {
                        id: "created",
                        actor: "System",
                        timestamp: new Date(product.createdAt).toLocaleString(),
                        dateTime: product.createdAt,
                        body: "Product created.",
                      },
                      {
                        id: "updated",
                        actor: "System",
                        timestamp: new Date(product.updatedAt).toLocaleString(),
                        dateTime: product.updatedAt,
                        body: "Product last updated.",
                      },
                    ]}
                  />
                </div>
              ),
            },
          ]}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Archive ${product.name}?`}
        description="The product moves to trash and can be restored."
        confirmLabel="Archive"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
