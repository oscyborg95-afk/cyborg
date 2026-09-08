export default function LoadingStockPlanner() {
  return <main className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6" aria-busy="true"><div className="h-28 animate-pulse rounded-[1.5rem] bg-track" /><div className="grid gap-3 sm:grid-cols-4">{[0,1,2,3].map((x)=><div key={x} className="h-24 animate-pulse rounded-[1.25rem] bg-track" />)}</div><div className="h-80 animate-pulse rounded-[1.5rem] bg-track" /></main>;
}
