# NeoTerrainMap

위성영상 위에 `no-go` / `uncertain` 지형 마스크만 제공하는 지도 레이어 MVP입니다.

이 앱은 경로 탐색, 차량별 통행 가능성, 예상시간을 제공하지 않습니다. 다른 회사의 경로 엔진이 사용할 수 있는 지형 제약 레이어를 만드는 것이 목적입니다.

## MVP 범위

- Esri World Imagery 배경지도
- AOI 지정
- 못 가는 영역 마스크
- 불확실 영역 마스크
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

## 다음 단계

- SAM3.1 서버 결과를 현재 synthetic mask 대신 연결
- DEM 기반 급경사/계곡선 실제 계산 연결
- GeoTIFF/COG/PMTiles export
- 고객 제공 정사영상 업로드 모드

## 라이선스 메모

현재 MVP는 Esri World Imagery를 화면 배경으로 사용합니다. 상용 납품에서 위성영상을 저장/가공/재배포하거나 AI 입력으로 대량 처리하려면 별도 사용권 검토가 필요합니다.
