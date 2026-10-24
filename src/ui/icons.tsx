const CREST_FILE: Record<string, string> = {
  "СЛ": "seal-solar",
  "ВГ": "seal-vega",
  "ОР": "seal-orion",
  "ЛР": "seal-lyra",
};

export function crestFile(crest: string): string | null {
  return CREST_FILE[crest] ?? null;
}

export function Icon({ name, size = 24 }: { name: string; size?: number }) {
  const url = `/icons/${name}.svg`;
  return (
    <span
      className="icon"
      style={{ width: size, height: size, maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")` }}
      aria-hidden="true"
    />
  );
}

export function Seal({ crest, size }: { crest: string; size: 16 | 24 | 56 }) {
  const file = crestFile(crest);
  if (!file) return <span className="seal-fallback" aria-hidden="true">{crest}</span>;
  return <img className="seal" src={`/icons/${file}-${size}.svg`} width={size} height={size} alt="" />;
}
