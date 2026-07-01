# NeoTerrainMap

위성영상 위에 `no-go` / `uncertain` 지형 마스크만 제공하는 지도 레이어 MVP입니다.

이 앱은 경로 탐색, 차량별 통행 가능성, 예상시간을 제공하지 않습니다. 다른 회사의 경로 엔진이 사용할 수 있는 지형 제약 레이어를 만드는 것이 목적입니다.

## MVP 범위

- Esri World Imagery 배경지도
- AOI 지정
- SAM3.1 기반 못 가는 영역 마스크
- SAM3.1 기반 불확실 영역 마스크
- 근거별 색상 표시
- 마스크 클릭 시 이유/신뢰도 표시
- GeoJSON / JSON export

## 실행

```bash
python3 -m http.server 8140
```

브라우저에서 여세요.

```text
http://127.0.0.1:8140
```

## SAM3.1 develop 서버

프론트의 기본 SAM API는 현재 develop 서버를 바라보는 공개 tunnel 주소입니다.

```text
https://arg-founder-production-attended.trycloudflare.com/sam/roi
```

develop 서버에서 실행:

```bash
cd /path/to/neoterrain-map
cp .env.example .env
python3 server/sam_roi_server.py --host 127.0.0.1 --port 8787
```

로컬 Mac에서 develop으로 터널:

```bash
ssh -N -L 8787:127.0.0.1:8787 develop
```

브라우저에서는 `연결 확인`으로 `/healthz`를 확인한 뒤 `분석 실행`을 누르면 됩니다.

### 서버 응답 계약

`POST /sam/roi`는 AOI 중심, bbox, meter 크기, grid 조건을 받아 작업을 생성합니다.

```json
{
  "center": { "lat": 37.6865, "lng": 127.408 },
  "bbox": { "south": 37.67, "west": 127.39, "north": 37.70, "east": 127.42 },
  "meters": { "width": 2000, "height": 2000 },
  "grid": { "n": 200, "cellM": 10 },
  "image": { "source": "Esri World Imagery", "zoom": 16, "size": 1536 }
}
```

서버는 `statusUrl`을 반환하고, 완료되면 `segmentation_grid.json`을 제공합니다. 프론트는 이 grid를 직접 보여주지 않고 `water/stream/built/forest` 판독 결과만 no-go/uncertain mask polygon으로 변환합니다.

## 다음 단계

- DEM 기반 급경사/계곡선 실제 계산 연결
- GeoTIFF/COG/PMTiles export
- 고객 제공 정사영상 업로드 모드

## 라이선스 메모

현재 MVP는 Esri World Imagery를 화면 배경으로 사용합니다. 상용 납품에서 위성영상을 저장/가공/재배포하거나 AI 입력으로 대량 처리하려면 별도 사용권 검토가 필요합니다.
