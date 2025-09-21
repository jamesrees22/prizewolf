export default function Home() {
  return (
    <div className="min-h-screen bg-midnight-blue text-wolf-grey flex flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold text-electric-gold mb-8">Redirecting to Search...</h1>
      <p className="text-neon-red">You will be taken to the search page shortly.</p>
      <script
        dangerouslySetInnerHTML={{
          __html: `setTimeout(() => window.location.href = '/search', 2000);`,
        }}
      />
    </div>
  );
}