{{- define "navis.image" -}}
{{ .root.Values.image.registry }}/{{ .root.Values.image.repository }}/{{ .target }}:{{ .root.Values.image.tag }}
{{- end -}}

{{- define "navis.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: navis
{{- end -}}
