/**
 * Placeholder rendered by every not-yet-implemented module route. Module
 * agents replace the placeholder file with the real page — no nav rewrites.
 */
export function ModulePlaceholder({ title, spec }: { title: string; spec?: string }) {
  return (
    <div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="mt-6 rounded-lg border border-dashed p-10 text-center">
        <p className="text-sm font-medium">Coming soon</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          The {title} module hasn&apos;t been implemented yet.
          {spec ? ` See spec ${spec} for scope.` : " See the module spec for scope."}
        </p>
      </div>
    </div>
  )
}
