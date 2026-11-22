proxy_pass http://gateway_upstream;
proxy_pass_request_headers off;
proxy_set_header Host $http_host;
proxy_set_header Origin $http_origin;
proxy_set_header Accept $http_accept;
proxy_set_header Content-Type $http_content_type;
proxy_set_header Authorization $http_authorization;
proxy_set_header Cookie $http_cookie;
proxy_set_header Sec-Fetch-Site $http_sec_fetch_site;
proxy_set_header X-Navis-Protocol $http_x_navis_protocol;
proxy_set_header Range $http_range;
proxy_set_header Idempotency-Key $http_idempotency_key;
# Incoming headers are allowlisted above. Only nginx can supply a gate proof.
proxy_set_header X-Navis-Edge-Demo-Proof $navis_edge_demo_proof;
client_max_body_size 10m;
proxy_read_timeout 180s;
proxy_buffering off;
