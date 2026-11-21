# Navis 배포 구성 (샘플)

> 이 폴더의 파일은 **NAVER Cloud Platform 배포 구조를 보여 주기 위한 샘플**입니다.
> `{sample: ...}`로 적힌 값은 모두 예시이며, 실제 계정·키·주소는 저장소에 두지 않습니다.

## 배포 흐름

```text
GitHub (main push)
   └─ GitHub Actions ── 시험 → 이미지 빌드(backend/Dockerfile 타깃별) → Ncloud Container Registry 푸시
                            └─ helm upgrade ──▶ NKS 클러스터 (NCP IAM 인증)

인터넷 ─▶ ALB (HTTPS 443, Certificate Manager)
           └─▶ edge (nginx, NodePort) ─┬─ '/'    ─▶ frontend (정적 SPA)
                                        └─ '/api' ─▶ api-gateway ─▶ account · pos · inventory · customer · marketing · insight
                                                                         │
                                       Cloud DB for PostgreSQL ◀─────────┤ (서비스별 논리 DB 6개, 사설 엔드포인트)
                                       Redis (StatefulSet) ◀── outbox-relay · 소비자
```

## 파일

| 파일 | 내용 |
| :--- | :--- |
| `helm/navis/Chart.yaml` | 차트 정보 |
| `helm/navis/values.yaml` | 이미지 레지스트리, 도메인, DB 주소, 서비스별 복제 수·환경변수·비밀값 이름 |
| `helm/navis/templates/workloads.yaml` | 서비스마다 Deployment + Service, `/healthz`·`/readyz` 프로브, 비밀값 파일 마운트 |
| `helm/navis/templates/ingress.yaml` | NCP ALB Ingress (`ingressClassName: alb`) |
| `helm/navis/templates/redis.yaml` | Redis StatefulSet (Streams·캐시·잠금) |
| `helm/navis/templates/forecast-cron.yaml` | 재고 수요 예측 CronJob |
| `helm/navis/secrets.example.yaml` | 서비스별 Secret 형식 예시 |
| `github-actions/deploy.yml.example` | 시험 → 빌드 → NCR 푸시 → helm 배포 워크플로 예시 |

## 원칙

- 비밀값은 환경변수가 아니라 **파일(`/run/secrets/<이름>`)로 마운트**합니다. 로컬 Compose와 같은 방식입니다.
- 서비스끼리는 클러스터 안 ClusterIP로만 통신하고, 외부에 열리는 것은 ALB → edge 하나뿐입니다.
- 각 서비스는 자기 DB 역할로만 접속하며, 매장 데이터는 PostgreSQL RLS로 한 번 더 격리합니다.
- 실제 클라우드 자원 생성과 배포는 비용 승인 후 진행합니다.
