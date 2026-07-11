#!/bin/bash
# ============================================================
# Una Rolita — comandos para inicializar el repo en GitHub
# Ejecuta esto en tu propia máquina, no aquí.
# Requiere: git instalado, y gh CLI (https://cli.github.com) autenticado
# ============================================================

# 1. Inicializar git localmente
git init
git add .
git commit -m "chore: estructura inicial del proyecto Una Rolita"
git branch -M main

# 2. Crear el repositorio en GitHub (privado) y subirlo
gh repo create una-rolita --private --source=. --remote=origin
git push -u origin main

# 3. Crear la rama develop
git checkout -b develop
git push -u origin develop

# 4. Proteger la rama main (requiere permisos de admin del repo)
gh api repos/:owner/una-rolita/branches/main/protection \
  --method PUT \
  --input - <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["lint-and-test"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1
  },
  "restrictions": null
}
EOF

echo "Listo. Revisa en GitHub: Settings > Branches > main debe mostrar la protección activa."
